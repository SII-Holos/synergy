import path from "node:path"
import ignore, { type Ignore } from "ignore"
import { ProcessOutput } from "@ericsanchezok/synergy-harness/process/output"
import { FileView } from "./view"

export namespace FileScan {
  interface Rule {
    prefix: string
    priority: number
    matcher: Ignore
  }
  export interface Input {
    cwd: string
    glob?: string[]
    hidden?: boolean
    follow?: boolean
    maxDepth?: number
    maxRecordBytes?: number
    maxOutputBytes?: number
    signal?: AbortSignal
  }

  export async function* files(input: Input): AsyncGenerator<string> {
    const root = FileView.relative(input.cwd)
    const overrides = ignore({ ignorecase: false }).add(
      (input.glob ?? []).map((glob) => (glob.startsWith("!") ? glob.slice(1) : `!${glob}`)),
    )
    const whitelist = input.glob?.some((glob) => !glob.startsWith("!")) ?? false
    const maxOutput = input.maxOutputBytes ?? 20 * 1024 * 1024
    const maxRecord = input.maxRecordBytes ?? 256 * 1024
    let output = 0
    let visited = 0
    const loadRules = async (directory: string, parents: Rule[]) => {
      const rules = [...parents]
      for (const [priority, filename] of [".gitignore", ".ignore", ".rgignore"].entries()) {
        const absolute = directory ? `${directory}/${filename}` : filename
        const info = await FileView.stat(absolute, true)
        if (!info || info.kind !== "file") continue
        if (info.size > 1024 * 1024) throw new Error("Workspace ignore file exceeds 1 MiB")
        const bytes = await FileView.bytes(absolute, undefined, 1024 * 1024)
        rules.push({
          prefix: directory ? `${directory}/` : "",
          priority,
          matcher: ignore({ ignorecase: false }).add(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        })
      }
      return rules.sort((a, b) => a.priority - b.priority)
    }
    const ignored = (filename: string, rules: Rule[], directory: boolean) => {
      let result = false
      let included = false
      for (const rule of rules) {
        if (!filename.startsWith(rule.prefix)) continue
        const relative = filename.slice(rule.prefix.length) + (directory ? "/" : "")
        const match = rule.matcher.test(relative)
        if (match.ignored) {
          result = true
          included = false
        }
        if (match.unignored) {
          result = false
          included = true
        }
      }
      return { ignored: result, included }
    }
    const walk = async function* (
      directory: string,
      parents: Rule[],
      ancestors: Set<string>,
      depth: number,
    ): AsyncGenerator<string> {
      input.signal?.throwIfAborted()
      if (depth > 256) throw new Error("Workspace search exceeds 256 directory levels")
      const canonical = await FileView.canonical(directory)
      if (ancestors.has(canonical)) return
      const nextAncestors = new Set([...ancestors, canonical])
      const rules = await loadRules(directory, parents)
      const entries = (await FileView.list(directory)).sort((a, b) => a.path.localeCompare(b.path))
      for (const entry of entries) {
        input.signal?.throwIfAborted()
        if (++visited > 100_000) throw new Error("Workspace search exceeds 100,000 entries")
        if (path.posix.basename(entry.path) === ".git") continue
        const relative = root ? entry.path.slice(root.length + 1) : entry.path
        const target =
          entry.kind === "symlink" && input.follow !== false ? await FileView.stat(entry.path, true) : entry
        const isDirectory = target?.kind === "directory"
        const match = overrides.test(relative + (isDirectory ? "/" : ""))
        if (match.ignored) continue
        const rule = ignored(entry.path, rules, isDirectory)
        if (!match.unignored && rule.ignored) continue
        if (
          input.hidden === false &&
          path.posix.basename(entry.path).startsWith(".") &&
          !match.unignored &&
          !rule.included
        )
          continue
        if (isDirectory) {
          if (input.maxDepth === undefined || depth + 1 < input.maxDepth)
            yield* walk(entry.path, rules, nextAncestors, depth + 1)
          continue
        }
        if (target?.kind !== "file" || (whitelist && !match.unignored)) continue
        const bytes = Buffer.byteLength(relative) + 1
        if (bytes > maxRecord) throw new ProcessOutput.LimitError("max_record_bytes", maxRecord)
        if ((output += bytes) > maxOutput) throw new ProcessOutput.LimitError("max_output_bytes", maxOutput)
        yield relative
      }
    }
    if (input.maxDepth !== undefined && (!Number.isInteger(input.maxDepth) || input.maxDepth < 0))
      throw new Error("Invalid search depth")
    if (input.maxDepth === 0) return
    if ((await FileView.stat(input.cwd, true))?.kind !== "directory")
      throw Object.assign(new Error("Workspace search directory is absent"), { code: "ENOENT" })
    let parents: Rule[] = []
    const exclude = await FileView.stat(".git/info/exclude", true)
    if (exclude?.kind === "file") {
      if (exclude.size > 1024 * 1024) throw new Error("Workspace ignore file exceeds 1 MiB")
      parents.push({
        prefix: "",
        priority: -1,
        matcher: ignore({ ignorecase: false }).add(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await FileView.bytes(".git/info/exclude", undefined, 1024 * 1024),
          ),
        ),
      })
    }
    const parts = root ? root.split("/") : []
    for (let index = 0; index < parts.length; index++)
      parents = await loadRules(parts.slice(0, index).join("/"), parents)
    try {
      yield* walk(root, parents, new Set(), 0)
    } catch (error) {
      if (!input.signal?.aborted) throw error
    }
  }
}
