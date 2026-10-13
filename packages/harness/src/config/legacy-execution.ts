import path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { mergeDeep } from "remeda"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { RuntimeContext } from "../lifecycle/context"
import { Log } from "../util/log"
import { ConfigDomain } from "./domain"
import { ConfigReferenceMigration } from "./reference-migration"

/** One-release input adapter. Persisted files are upgraded by the config migration. */
export namespace LegacyExecutionConfig {
  const log = Log.create({ service: "config.legacy-execution" })
  const runtimeState = RuntimeContext.state(() => ({
    warned: new Set<string>(),
  }))
  const fields = {
    coauthor_reminder: ["prompt", "coauthorReminder"],
    openTelemetry: ["observability", "modelSpans"],
    primary_tools: ["cortex", "primaryOnlyTools"],
    continue_loop_on_deny: ["execution", "continueOnDeny"],
    mcp_timeout: ["mcpDefaults", "callTimeout"],
    boss_mode: ["boss", "enabled"],
    boss_identity_text: ["boss", "identityText"],
    boss_briefing_interval_days: ["boss", "briefingIntervalDays"],
    boss_persona: ["boss", "persona"],
  } as const
  function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
  }
  export function migrate(value: unknown): unknown {
    if (!object(value) || !object(value.experimental)) return value
    const result = structuredClone(value)
    const legacy = result.experimental as Record<string, unknown>
    for (const [old, [domain, key]] of Object.entries(fields)) {
      if (!(old in legacy) || !ConfigDomain.domainForKey(domain)) continue
      const current = result[domain]
      if (current !== undefined && !object(current)) throw new Error(`Invalid ${domain} configuration`)
      result[domain] = { ...current, [key]: old === "mcp_timeout" ? legacy[old] : (current?.[key] ?? legacy[old]) }
      delete legacy[old]
    }
    delete legacy.batch_tool
    if (!Object.keys(legacy).length) delete result.experimental
    return result
  }
  export function upgradeConfig(config: Record<string, unknown>) {
    const migrated = migrate(config)
    if (!object(migrated)) return
    Object.assign(config, migrated)
    if (!("experimental" in migrated)) delete config.experimental
  }

  async function read(filepath: string) {
    const raw = await Bun.file(filepath)
      .text()
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
    if (raw === undefined || !raw.trim()) return undefined
    const errors: ParseError[] = []
    const config: unknown = parse(raw, errors, { allowTrailingComma: true })
    if (errors.length || !object(config)) throw new Error("Invalid configuration migration input")
    return { raw, config }
  }

  export async function file(filepath: string): Promise<boolean> {
    const current = await read(filepath)
    if (!current || !("experimental" in current.config)) return false
    const migrated = migrate(current.config)
    if (!object(migrated)) return false
    const owner = ConfigDomain.domainForFile(filepath)
    const domainFile = owner || path.basename(path.dirname(filepath)) === "synergy.d"
    const formattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" } as const
    let text = current.raw
    for (const key of new Set([...Object.keys(current.config), ...Object.keys(migrated)])) {
      const value = migrated[key]
      if (JSON.stringify(current.config[key]) === JSON.stringify(value)) continue
      const targetOwner = ConfigDomain.domainForKey(key)
      if (domainFile && targetOwner && targetOwner.id !== owner?.id) {
        const target = path.join(path.dirname(filepath), targetOwner.filename)
        const existing = await read(target)
        const stored = existing?.config[key]
        const merged =
          object(stored) && object(value)
            ? key === "mcpDefaults"
              ? mergeDeep(stored, value)
              : mergeDeep(value, stored)
            : (stored ?? value)
        const raw = existing?.raw ?? "{}"
        const updated = applyEdits(raw, modify(raw, [key], merged, { formattingOptions }))
        if (updated !== raw) await AtomicFile.writeFileAtomic(target, updated, { private: true, durable: true })
        text = applyEdits(text, modify(text, [key], undefined, { formattingOptions }))
      } else text = applyEdits(text, modify(text, [key], value, { formattingOptions }))
    }
    if (text === current.raw) return false
    await AtomicFile.writeFileAtomic(filepath, text, { private: true, durable: true })
    return true
  }

  export async function up(progress: (current: number, total: number) => void) {
    await ConfigReferenceMigration.up(progress, { transform: file })
  }
  export function environment(env: NodeJS.ProcessEnv = RuntimeContext.current().host.env): Record<string, unknown> {
    const instanceState = runtimeState()

    const result: Record<string, unknown> = {}
    function enabled(key: string) {
      if (env[key] === undefined) return false
      if (!instanceState.warned.has(key)) {
        instanceState.warned.add(key)
        log.warn("Deprecated execution environment variable; use domain config or an experiment file", { name: key })
      }
      return env[key]?.toLowerCase() === "true" || env[key] === "1"
    }
    const preview = enabled("SYNERGY_EXPERIMENTAL")
    if (enabled("SYNERGY_DISABLE_AUTOCOMPACT")) result.compaction = { auto: false }
    if (enabled("SYNERGY_DISABLE_PRUNE")) result.compaction = { ...(result.compaction as object), prune: false }
    const execution: Record<string, unknown> = {}
    const cache: Record<string, boolean> = {}
    if (enabled("SYNERGY_DISABLE_MESSAGE_CACHE")) cache.enabled = false
    if (enabled("SYNERGY_VERIFY_MESSAGE_CACHE")) cache.verify = true
    if (Object.keys(cache).length) execution.messageCache = cache
    if (enabled("SYNERGY_DISABLE_LSP_REAP")) execution.lspIdleReap = false
    if (Object.keys(execution).length) result.execution = execution
    if (enabled("SYNERGY_EXPERIMENTAL_OXFMT") || preview) result.formatter = { oxfmt: { disabled: false } }
    if (enabled("SYNERGY_EXPERIMENTAL_LSP_TY")) result.lsp = { ty: { disabled: false }, pyright: { disabled: true } }
    if (enabled("SYNERGY_EXPERIMENTAL_LSP_TOOL") || preview) result.toolExposure = { lsp: true }
    return result
  }
}
