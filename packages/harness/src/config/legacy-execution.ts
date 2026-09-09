import { Log } from "../util/log"

/** One-release input adapter. Persisted files are upgraded by the config migration. */
export namespace LegacyExecutionConfig {
  const log = Log.create({ service: "config.legacy-execution" })
  const warned = new Set<string>()
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
    const legacy = value.experimental
    for (const [old, [domain, key]] of Object.entries(fields)) {
      if (!(old in legacy)) continue
      const current = result[domain]
      if (current !== undefined && !object(current)) throw new Error(`Invalid ${domain} configuration`)
      result[domain] = { ...current, [key]: old === "mcp_timeout" ? legacy[old] : (current?.[key] ?? legacy[old]) }
    }
    const unknown = Object.keys(legacy).filter((key) => key !== "batch_tool" && !(key in fields))
    if (unknown.length) throw new Error(`Unknown legacy execution settings: ${unknown.join(", ")}`)
    delete result.experimental
    return result
  }
  export function environment(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    function enabled(key: string) {
      if (env[key] === undefined) return false
      if (!warned.has(key)) {
        warned.add(key)
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
