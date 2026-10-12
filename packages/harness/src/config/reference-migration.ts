import path from "node:path"
import fs from "node:fs/promises"
import matter from "gray-matter"
import { applyEdits, modify, parse, parseTree, type Edit, type Node, type ParseError } from "jsonc-parser"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { PrimaryAgentUpgrade } from "../agent/primary-identity-upgrade"
import { upgradeImportedConfig } from "../migration/import"
import { ConfigMarkdown } from "./markdown"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { Storage } from "../storage/storage"
import { ConfigDomain } from "./domain"
import { mergeDeep } from "remeda"

export namespace ConfigReferenceMigration {
  interface Options {
    relocateKeys?: readonly string[]
    transform?: (filepath: string) => Promise<unknown>
  }
  function keyEdits(node: Node | undefined, after: unknown): Edit[] {
    if (node?.type === "array" && Array.isArray(after))
      return (node.children ?? []).flatMap((child, index) => keyEdits(child, after[index]))
    const record = PrimaryAgentUpgrade.record(after)
    if (node?.type !== "object" || !record) return []
    const keys = new Set((node.children ?? []).map((property) => property.children?.[0]?.value))
    return (node.children ?? []).flatMap((property) => {
      const [key, value] = property.children ?? []
      if (!key || typeof key.value !== "string") return []
      const renamed = PrimaryAgentUpgrade.name(key.value)
      const next =
        renamed !== key.value &&
        Object.hasOwn(record, renamed) &&
        !Object.hasOwn(record, key.value) &&
        !keys.has(renamed)
          ? renamed
          : key.value
      return [
        ...(next === key.value ? [] : [{ offset: key.offset, length: key.length, content: JSON.stringify(next) }]),
        ...keyEdits(value, record[next]),
      ]
    })
  }

  function edits(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    prefix: string[] = [],
  ): Array<{ path: string[]; value: unknown }> {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) => {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) return []
      const previous = PrimaryAgentUpgrade.record(before[key])
      const next = PrimaryAgentUpgrade.record(after[key])
      return previous && next
        ? edits(previous, next, [...prefix, key])
        : [{ path: [...prefix, key], value: after[key] }]
    })
  }

  export async function file(filepath: string, options: Options = {}) {
    const raw = await Bun.file(filepath)
      .text()
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
    if (!raw) return
    const errors: ParseError[] = []
    const before = PrimaryAgentUpgrade.record(parse(raw, errors, { allowTrailingComma: true }))
    if (!before || errors.length) return
    const after = upgradeImportedConfig(before)
    const owner = ConfigDomain.domainForFile(filepath)
    if (owner || path.basename(path.dirname(filepath)) === "synergy.d") {
      for (const [key, value] of Object.entries(after)) {
        if (JSON.stringify(before[key]) === JSON.stringify(value) && !options.relocateKeys?.includes(key)) continue
        const targetOwner = ConfigDomain.domainForKey(key)
        if (!targetOwner || targetOwner.id === owner?.id) continue
        const target = path.join(path.dirname(filepath), targetOwner.filename)
        const targetRaw = await Bun.file(target)
          .text()
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "{}"
            throw error
          })
        const targetErrors: ParseError[] = []
        const stored = PrimaryAgentUpgrade.record(parse(targetRaw, targetErrors, { allowTrailingComma: true }))
        if (!stored || targetErrors.length)
          throw new Error(`Cannot migrate configuration into invalid domain ${targetOwner.id}`)
        const incoming = PrimaryAgentUpgrade.record(value)
        const current = PrimaryAgentUpgrade.record(stored[key])
        const merged =
          incoming && current ? mergeDeep(incoming, current) : Object.hasOwn(stored, key) ? stored[key] : value
        const updated = applyEdits(
          targetRaw,
          modify(targetRaw, [key], merged, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
        )
        // Publish the destination first so an interrupted move can retry without losing the source.
        if (updated !== targetRaw) await AtomicFile.writeFileAtomic(target, updated, { private: true, durable: true })
        delete after[key]
      }
    }
    let text = applyEdits(raw, keyEdits(parseTree(raw), after))
    const keyed = PrimaryAgentUpgrade.record(parse(text))!
    for (const edit of edits(keyed, after)) {
      text = applyEdits(
        text,
        modify(text, edit.path, edit.value, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
      )
    }
    if (text !== raw) await AtomicFile.writeFileAtomic(filepath, text, { private: true, durable: true })
  }

  async function markdown(filepath: string, relative: string) {
    const parsed = await ConfigMarkdown.parse(filepath)
    const data = PrimaryAgentUpgrade.record(parsed.data) ?? {}
    const before = JSON.stringify(data)
    const identity = relative.match(/^(?:agent|agents)\/([^/]+)\.md$/)?.[1]
    const next = identity ? PrimaryAgentUpgrade.name(identity) : undefined
    if (next && next !== identity && data.name === undefined) data.name = next
    if (/^(?:agent|agents)\//.test(relative)) upgradeAgentDefinition(data)
    else PrimaryAgentUpgrade.fields(data, ["agent"])
    const changed = JSON.stringify(data) !== before
    const content = changed
      ? `${matter.stringify("", data).trimEnd()}\n${parsed.content}`
      : await Bun.file(filepath).text()
    if (next && next !== identity) {
      const destination = path.join(path.dirname(filepath), `${next}.md`)
      const staging = await fs.mkdtemp(path.join(path.dirname(filepath), ".primary-agent-upgrade-"))
      try {
        const prepared = path.join(staging, "definition")
        await AtomicFile.writeFileAtomic(prepared, content, { private: true, durable: true })
        // A hard link publishes complete bytes without ever replacing an existing definition.
        await fs.link(prepared, destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") throw PrimaryAgentUpgrade.collision(identity!, next)
          throw error
        })
        await AtomicFile.syncDirectories(path.dirname(filepath))
        await fs.unlink(filepath)
        await AtomicFile.syncDirectories(path.dirname(filepath))
      } finally {
        await fs.rm(staging, { recursive: true, force: true })
      }
      return
    }
    if (changed) await AtomicFile.writeFileAtomic(filepath, content, { private: true, durable: true })
  }

  export function upgradeAgentDefinition(value: unknown) {
    const agent = PrimaryAgentUpgrade.record(value)
    if (!agent) return
    PrimaryAgentUpgrade.fields(agent, ["name"])
    if (Array.isArray(agent.visibleTo))
      agent.visibleTo = agent.visibleTo.map((value) =>
        typeof value === "string" ? PrimaryAgentUpgrade.name(value) : value,
      )
    const permission = PrimaryAgentUpgrade.record(agent.permission)
    PrimaryAgentUpgrade.keys(permission?.task)
  }

  export function upgradeConfig(config: Record<string, unknown>) {
    PrimaryAgentUpgrade.fields(config, ["default_agent"])
    const agents = PrimaryAgentUpgrade.record(config.agent)
    for (const value of Object.values(agents ?? {})) upgradeAgentDefinition(value)
    PrimaryAgentUpgrade.keys(agents)
    for (const command of Object.values(PrimaryAgentUpgrade.record(config.command) ?? {}))
      PrimaryAgentUpgrade.fields(command, ["agent"])
    const permission = PrimaryAgentUpgrade.record(config.permission)
    PrimaryAgentUpgrade.keys(permission?.task)
  }

  export async function directory(root: string, options: Options = {}) {
    const transform = options.transform ?? ((filepath: string) => file(filepath, options))
    const exists = await fs.stat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!exists?.isDirectory()) return
    for (const pattern of ["synergy.{json,jsonc}", "synergy.d/*.{json,jsonc}"]) {
      for await (const relative of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true, followSymlinks: true }))
        await transform(path.join(root, relative))
    }
    for await (const relative of new Bun.Glob("{agent,agents,command,commands}/**/*.md").scan({
      cwd: root,
      onlyFiles: true,
      followSymlinks: true,
    })) {
      await markdown(path.join(root, relative), relative.replaceAll("\\", "/"))
    }
  }

  export async function up(progress: (current: number, total: number) => void, options: Options = {}) {
    const transform = options.transform ?? ((filepath: string) => file(filepath, options))
    const roots = new Set([Global.Path.config])
    const addProject = (directory: string) => {
      for (let current = path.resolve(directory); ; current = path.dirname(current)) {
        roots.add(path.join(current, ".synergy"))
        if (path.dirname(current) === current) break
      }
    }
    if (Flag.SYNERGY_CWD) addProject(Flag.SYNERGY_CWD)
    addProject(Global.Path.home)
    for await (const { value } of Storage.records<Record<string, unknown>>({ kind: "projects" })) {
      const local = PrimaryAgentUpgrade.record(value.local)
      if (typeof local?.directory === "string") addProject(local.directory)
    }
    const sets = path.join(Global.Path.config, "config-sets")
    for (const entry of await fs.readdir(sets, { withFileTypes: true }).catch(() => []))
      if (entry.isDirectory()) roots.add(path.join(sets, entry.name))
    if (Flag.SYNERGY_CONFIG_DIR) roots.add(Flag.SYNERGY_CONFIG_DIR)
    let done = 0
    for (const root of roots) {
      await directory(root, options)
      if (path.basename(root) === ".synergy")
        for (const name of ["synergy.json", "synergy.jsonc"]) await transform(path.join(path.dirname(root), name))
      progress(++done, roots.size)
    }
    if (Flag.SYNERGY_CONFIG) await transform(Flag.SYNERGY_CONFIG)
  }
}
