import path from "path"
import { existsSync } from "fs"
import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { GlobalBus } from "../bus/global"
import { Config } from "../config/config"
import { CortexConcurrency } from "../cortex/concurrency"
import { ConfigDomain } from "../config/domain"
import { ScopeContext } from "../scope/context"
import { RuntimeSchema } from "./schema"
import { Log } from "../util/log"
import { isPathContained } from "../util/path-contain"
import type { Skill } from "../skill/skill"
import { RuntimeReloadPath } from "./reload-path"

export namespace RuntimeReload {
  export const Target = RuntimeSchema.ReloadTarget
  export type Target = RuntimeSchema.ReloadTarget

  export const Scope = RuntimeSchema.ReloadScope
  export type Scope = RuntimeSchema.ReloadScope

  export const Result = RuntimeSchema.ReloadResult
  export type Result = RuntimeSchema.ReloadResult

  const CONFIG_RESTART_REQUIRED = new Set(["server", "logLevel"])
  const BUILTIN_SOURCE_RESTART_WARNING =
    "Runtime reload refreshes runtime state only. Source edits under packages/synergy/src still require restarting the backend process to load new built-in module code."
  export const CONFIG_LIVE_APPLIED = new Set([
    "model",
    "nano_model",
    "mini_model",
    "mid_model",
    "thinking_model",
    "long_context_model",
    "creative_model",
    "vision_model",
    "role_variant",
    "default_agent",
    "username",
    "category",
    "compaction",
    "cortex",
    "snapshot",
    "lspWriteDiagnostics",
    "lspDiagnostics",
    //     "agora",
    "instructions",
    "enterprise",
    "tools",
    "embedding",
    "rerank",
    "library",
    "external_agent",
    "email",
    "github",
  ])
  export const CONFIG_CLIENT_SIDE = new Set(["theme", "keybinds", "layout", "toast"])

  export const Event = {
    Reloaded: BusEvent.define(
      "runtime.reloaded",
      z.object({
        executed: z.array(Target),
        cascaded: z.array(Target),
        changedFields: z.array(z.string()),
      }),
    ),
  }

  export const Input = z.object({
    targets: z.array(Target).min(1),
    scope: Scope.optional(),
    force: z.boolean().optional(),
    reason: z.string().optional(),
  })
  export type Input = z.infer<typeof Input>

  // ─── Target dependency map ───────────────────────────────────────────
  // If target A lists B, then B must be executed before A.
  // This replaces the previous implicit array-ordering approach.
  const TARGET_PREREQUISITES: Partial<Record<Target, Target[]>> = {
    provider: ["config"],
    agent: ["config"],
    plugin: ["config"],
    mcp: ["config"],
    lsp: ["config"],
    formatter: ["config"],
    watcher: ["config"],
    channel: ["config"],
    holos: ["config"],
    command: ["config"],
    tool_registry: ["config"],
    skill: [],
  }

  // After executing target A, also execute these targets (inline cascades).
  const TARGET_CASCADES: Partial<Record<Target, Target[]>> = {
    provider: ["agent"],
    mcp: ["command"],
    skill: ["command"],
    plugin: ["tool_registry", "agent", "skill"],
  }

  // ─── Core reload function ────────────────────────────────────────────

  export async function reload(input: Input): Promise<Result> {
    const params = Input.parse(input)
    const requested = normalizeTargets(params.targets)
    const executed = [] as Target[]
    const failed = [] as Target[]
    const failures: RuntimeSchema.ReloadFailure[] = []
    const diagnostics: RuntimeSchema.ReloadDiagnostic[] = []
    const warnings = [] as string[]
    const changedFields = new Set<string>()
    const restartRequired = new Set<string>()
    const liveApplied = new Set<string>()

    // P2: Centralized Config cache invalidation — all subsystems that read
    // Config.current() during their state() initialization will get fresh config.
    // This replaces the scattered Config.state.resetAll() calls that were
    // previously in individual subsystem reload() functions.
    const needsConfig = requested.includes("config") || requested.includes("all")
    if (needsConfig) {
      // Config reset is handled inside executeTarget("config") itself.
    } else {
      // Even when config target is not requested, subsystems may need fresh config.
      // Reset Config cache so that subsystem reload() calls get up-to-date config.
      await Config.state.resetAll()
    }

    const ctx: ExecuteContext = {
      scope: params.scope ?? "auto",
      executed,
      failed,
      failures,
      diagnostics,
      changedFields,
      restartRequired,
      liveApplied,
      warnings,
    }

    const targetsToExecute = requested.includes("all")
      ? normalizeTargets([
          "config",
          "provider",
          "agent",
          "plugin",
          "mcp",
          "lsp",
          "formatter",
          "watcher",
          "channel",
          "holos",
          "command",
          "tool_registry",
          "skill",
        ])
      : requested

    await Promise.all(targetsToExecute.map((target) => executeTarget(target, ctx)))

    const executedSet = new Set(executed)
    const cascaded = executed.filter((target) => !requested.includes(target))
    if (requested.includes("tool_registry") || requested.includes("all")) {
      warnings.push(BUILTIN_SOURCE_RESTART_WARNING)
    }
    if (changedFields.has("experimental") && !executedSet.has("mcp")) {
      warnings.push("experimental.mcp_timeout changes do not currently trigger MCP.reload() automatically")
    }

    const result: Result = {
      success: failed.length === 0,
      requested,
      executed: unique(executed),
      cascaded: unique(cascaded),
      changedFields: [...changedFields],
      restartRequired: [...restartRequired],
      liveApplied: [...liveApplied],
      warnings: unique(warnings),
      failed: unique(failed),
      failures,
      diagnostics,
    }

    GlobalBus.emit("event", {
      directory: ScopeContext.current.directory,
      payload: {
        type: Event.Reloaded.type,
        properties: {
          executed: result.executed,
          cascaded: result.cascaded,
          changedFields: result.changedFields,
        },
      },
    })

    return result
  }

  // ─── Execution context ───────────────────────────────────────────────

  interface ExecuteContext {
    scope: Scope
    executed: Target[]
    failed: Target[]
    failures: RuntimeSchema.ReloadFailure[]
    diagnostics: RuntimeSchema.ReloadDiagnostic[]
    changedFields: Set<string>
    restartRequired: Set<string>
    liveApplied: Set<string>
    warnings: string[]
  }

  // ─── Target executor ─────────────────────────────────────────────────

  async function executeTarget(target: Target, ctx: ExecuteContext) {
    if (target === "all") return
    if (ctx.executed.includes(target)) return

    // P8: Ensure prerequisites are executed first (explicit dependency, not array order)
    const prerequisites = TARGET_PREREQUISITES[target]
    if (prerequisites) {
      for (const prereq of prerequisites) {
        await executeTarget(prereq, ctx)
      }
    }

    // P9: Error isolation — one subsystem failure doesn't abort the whole reload
    try {
      await executeTargetCore(target, ctx)
      ctx.executed.push(target)

      // Execute inline cascades (e.g. provider → agent)
      const cascades = TARGET_CASCADES[target]
      if (cascades) {
        await Promise.all(cascades.map((cascade) => executeTarget(cascade, ctx)))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.failed.push(target)
      ctx.failures.push({ target, message, code: `${target}.reload_failed` })
      ctx.warnings.push(`Failed to reload ${target}: ${message}`)
      reloadLog.error("target reload failed", { target, error: err instanceof Error ? err : new Error(message) })
    }
  }

  function mapSkillDiagnostics(
    skillDiagnostics: Array<{
      path: string
      name: string
      message: string
      severity?: "error" | "warning" | "info"
      code?: string
      source?: string
    }>,
  ): RuntimeSchema.ReloadDiagnostic[] {
    return skillDiagnostics.map((d) => ({
      target: "skill" as const,
      severity: d.severity ?? "error",
      message: d.message,
      code: d.code,
      name: d.name,
      path: d.path,
      source: d.source,
    }))
  }

  async function executeTargetCore(target: Target, ctx: ExecuteContext) {
    switch (target) {
      case "config": {
        const resolvedScope = resolveConfigScope(ctx.scope)
        const result = await Config.reload(resolvedScope)
        for (const field of result.changedFields) {
          ctx.changedFields.add(field)
          if (CONFIG_RESTART_REQUIRED.has(field)) ctx.restartRequired.add(field)
          if (CONFIG_LIVE_APPLIED.has(field)) ctx.liveApplied.add(field)
          if (CONFIG_CLIENT_SIDE.has(field)) {
            ctx.warnings.push(`Config field \`${field}\` is client-side and is not reloaded by the server runtime`)
            ctx.diagnostics.push({
              target: "config",
              severity: "info",
              code: "config.client_side_field_not_reloaded",
              name: field,
              message: `Config field \`${field}\` is client-side and is not reloaded by the server runtime`,
            })
          }
        }
        if (resolvedScope === "global" && result.changedFields.includes("cortex")) {
          CortexConcurrency.configure(result.config.cortex?.maxConcurrentTasks)
        }
        if (resolvedScope === "global" && result.changedFields.includes("github")) {
          const { GitHubRuntime } = await import("../github/runtime")
          await GitHubRuntime.reload(result.config.github)
        }
        // Infer cascades from changed config fields
        for (const cascadedTarget of inferConfigCascades(result.changedFields)) {
          await executeTarget(cascadedTarget, ctx)
        }
        // P11: Handle library → autonomy/anima sync (migrated from Config.reload)
        if (result.changedFields.includes("library") && result.oldConfig) {
          const oldAutonomy = result.oldConfig.library?.autonomy !== false
          const newAutonomy = result.config.library?.autonomy !== false
          if (oldAutonomy !== newAutonomy) {
            try {
              const { AgendaBootstrap } = await import("../agenda/bootstrap")
              await AgendaBootstrap.syncAnima(newAutonomy)
            } catch (err) {
              ctx.warnings.push(
                `Failed to sync anima after library change: ${err instanceof Error ? err.message : String(err)}`,
              )
            }
          }
        }
        if (result.changedFields.includes("timeout")) {
          const { TimeoutConfig } = await import("@/util/timeout-config")
          TimeoutConfig.invalidate()
        }
        const { Plugin } = await import("../plugin")
        await Plugin.notifyConfigHooks({ source: "reload", config: result.config, changedFields: result.changedFields })
        return
      }
      case "provider": {
        const { Provider } = await import("../provider/provider")
        await Provider.reload()
        return
      }
      case "agent": {
        const { Agent } = await import("../agent/agent")
        await Agent.reload()
        return
      }
      case "plugin": {
        const { Plugin } = await import("../plugin")
        await Plugin.reload()
        await Plugin.init()
        // Collect disabled plugin diagnostics
        try {
          const disabled = await Plugin.getDisabled()
          for (const d of disabled) {
            ctx.diagnostics.push({
              target: "plugin",
              severity: "error",
              code: `plugin.${d.phase}_failed`,
              name: d.pluginId,
              path: d.entryPath ?? d.pluginDir ?? d.spec,
              phase: d.phase,
              source: d.source,
              message: d.reason,
            })
          }
        } catch {
          ctx.diagnostics.push({
            target: "plugin",
            severity: "warning",
            code: "plugin.diagnostics_unavailable",
            message: "Unable to collect disabled plugin diagnostics",
          })
        }
        return
      }
      case "mcp": {
        const { MCP } = await import("../mcp")
        const { Plugin } = await import("../plugin")
        await MCP.reload()
        await Plugin.reloadMcpContributions()
        return
      }
      case "lsp": {
        const { LSP } = await import("../lsp")
        await LSP.reload()
        return
      }
      case "formatter": {
        const { Format } = await import("../file/format")
        await Format.reload()
        return
      }
      case "watcher": {
        const { FileWatcher } = await import("../file/watcher")
        await FileWatcher.reload()
        return
      }
      case "channel": {
        const { Channel } = await import("../channel")
        await Channel.reload()
        return
      }
      case "holos": {
        const { HolosRuntime } = await import("../holos/runtime")
        await HolosRuntime.reload()
        return
      }
      case "command": {
        const { Command } = await import("../command/command")
        await Command.reload()
        return
      }
      case "tool_registry": {
        const { ToolRegistry } = await import("../tool/registry")
        await ToolRegistry.reload()
        return
      }
      case "skill": {
        const { Skill: SkillMod } = await import("../skill/skill")
        await SkillMod.reload()
        ctx.diagnostics.push(...mapSkillDiagnostics(await SkillMod.diagnostics()))
        return
      }
    }
  }

  function resolveConfigScope(scope: Scope): "global" | "project" {
    if (scope === "project") return "project"
    if (scope === "global") return "global"
    return hasProjectConfig() ? "project" : "global"
  }

  function hasProjectConfig() {
    return (
      [
        "synergy.jsonc",
        "synergy.json",
        path.join(".synergy", "synergy.jsonc"),
        path.join(".synergy", "synergy.json"),
      ].some((file) => existsSync(path.join(ScopeContext.current.directory, file))) ||
      ConfigDomain.definitions.some((domain) =>
        existsSync(path.join(ScopeContext.current.directory, ".synergy", "synergy.d", domain.filename)),
      )
    )
  }

  // ─── Config cascade inference ────────────────────────────────────────
  // P10: Ensured all config fields cascade correctly.
  // - model role changes → provider + agent (model may reference unloaded provider)
  // - category changes → provider + agent (category.model may reference different provider)
  // - default_agent, instruction files → agent
  // - tools → tool_registry

  export function inferConfigCascades(fields: string[]) {
    const cascaded = [] as Target[]
    const changed = new Set(fields)
    const providerChanged =
      changed.has("provider") || changed.has("disabled_providers") || changed.has("enabled_providers")

    if (providerChanged) {
      cascaded.push("provider", "agent")
    }
    const roleModelChanged = [
      "model",
      "nano_model",
      "mini_model",
      "mid_model",
      "thinking_model",
      "long_context_model",
      "creative_model",
      "vision_model",
      "role_variant",
    ].some((field) => changed.has(field))
    if (roleModelChanged) {
      // Model role changes only affect Config values, not Provider state.
      // resolveRoleModel() reads cfg[field], not Provider state.
      // Agent prompts reference the resolved model role and need reload.
      cascaded.push("agent")
    }
    if (changed.has("category")) {
      // Category configs can specify model overrides that reference different providers
      cascaded.push("provider", "agent")
    }
    if (changed.has("agent") || changed.has("permission") || changed.has("library") || changed.has("external_agent")) {
      cascaded.push("agent")
    }
    if (
      changed.has("default_agent") ||
      changed.has("instructions") ||
      changed.has("project_doc_fallback_filenames") ||
      changed.has("project_doc_max_bytes")
    ) {
      cascaded.push("agent")
    }
    if (changed.has("plugin")) {
      cascaded.push("plugin", "tool_registry")
    }
    if (changed.has("tools")) {
      cascaded.push("tool_registry")
    }
    if (changed.has("mcp")) {
      cascaded.push("mcp", "command")
    }
    if (changed.has("lsp")) {
      cascaded.push("lsp")
    }
    if (changed.has("formatter")) {
      cascaded.push("formatter")
    }
    if (changed.has("watcher")) {
      cascaded.push("watcher")
    }
    if (changed.has("channel")) {
      cascaded.push("channel")
    }
    if (changed.has("holos")) {
      cascaded.push("holos")
    }
    if (changed.has("command")) {
      cascaded.push("command")
    }
    if (changed.has("experimental")) {
      cascaded.push("tool_registry")
    }
    if (changed.has("timeout")) {
      cascaded.push("provider")
    }

    return unique(cascaded)
  }

  // ─── File path detection (shared between scope + target) ─────────────
  // P3: Unified path classification used by both detectScopeForFile and
  // detectTargetsForFile so they always agree.

  export function builtinSourceEditWarning(filePath: string) {
    const normalized = path.resolve(filePath)
    const builtinRoot = path.resolve(path.join(ScopeContext.current.directory, "packages", "synergy", "src"))
    if (!isPathContained(builtinRoot, normalized)) return undefined
    return BUILTIN_SOURCE_RESTART_WARNING
  }

  export function detectScopeForFile(filePath: string): Scope | undefined {
    return RuntimeReloadPath.detectScopeForFile(filePath)
  }

  export function detectTargetsForFile(filePath: string): Target[] {
    return RuntimeReloadPath.detectTargetsForFile(filePath)
  }

  function normalizeTargets(targets: Target[]) {
    return unique(targets.filter((target): target is Target => target !== undefined))
  }

  function unique<T>(items: T[]) {
    return [...new Set(items)]
  }

  // ─── Compact result formatter for auto-reload output ─────────────────

  /** Format a compact summary of reload diagnostics suitable for auto-reload tool output. */
  export function formatCompactResult(result: Result): string {
    const lines: string[] = [
      `Runtime reload applied`,
      `<runtime_reload>`,
      `targets=${result.requested.join(",")}`,
      `executed=${result.executed.join(",")}`,
    ]
    if (result.failed.length > 0) {
      lines.push(`failed=${result.failed.join(",")}`)
    }
    lines.push(`</runtime_reload>`)

    if (result.failures.length > 0) {
      for (const f of result.failures) {
        lines.push(`  - [failure] ${f.target} ${f.code ?? "unknown"}: ${f.message}`)
      }
    }
    const maxDiagnostics = 5
    if (result.diagnostics.length > 0) {
      const shown = result.diagnostics.slice(0, maxDiagnostics)
      for (const d of shown) {
        const loc = d.name ? ` ${d.name}` : d.path ? ` at ${d.path}` : ""
        lines.push(`  - [${d.severity}] ${d.target}${d.code ? ` ${d.code}` : ""}${loc}: ${d.message}`)
      }
      if (result.diagnostics.length > maxDiagnostics) {
        lines.push(`  ... and ${result.diagnostics.length - maxDiagnostics} more diagnostics in metadata.runtimeReload`)
      }
    }

    return lines.join("\n")
  }

  // ─── Auto-reload (file watcher integration) ─────────────────────────

  const reloadLog = Log.create({ service: "runtime.reload.auto" })
  const DEFAULT_DEBOUNCE_MS = 500

  // P12: Debounce per scope rather than per file.
  // Multiple file changes within the same scope during the debounce window
  // are merged into a single reload with the union of their targets.
  let debounceTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; targets: Set<Target> }>()

  function debounceReload(_file: string, scope: "global" | "project", targets: Target[]) {
    const key = scope
    const existing = debounceTimers.get(key)
    if (existing) {
      clearTimeout(existing.timer)
      for (const t of targets) existing.targets.add(t)
    }
    const mergedTargets = existing?.targets ?? new Set<Target>(targets)
    for (const t of targets) mergedTargets.add(t)

    const timer = setTimeout(async () => {
      debounceTimers.delete(key)
      const finalTargets = [...mergedTargets]
      if (finalTargets.length === 0) return
      reloadLog.info("auto-reloading", { scope, targets: finalTargets })
      try {
        const result = await reload({
          targets: finalTargets,
          scope,
          reason: `auto-reload: file changed in ${scope} scope`,
        })
        reloadLog.info("auto-reload complete", {
          executed: result.executed,
          cascaded: result.cascaded,
          warnings: result.warnings,
        })
      } catch (err) {
        reloadLog.error("auto-reload failed", { error: err instanceof Error ? err : new Error(String(err)) })
      }
    }, DEFAULT_DEBOUNCE_MS)

    debounceTimers.set(key, { timer, targets: mergedTargets })
  }

  function handleGlobalConfigEvent(event: { file: string; event: string }) {
    const targets = detectTargetsForFile(event.file)
    if (targets.length === 0) {
      reloadLog.info("no targets detected for file, skipping", { file: event.file })
      return
    }
    const scope = detectScopeForFile(event.file)
    if (!scope || scope === "auto") {
      reloadLog.info("could not detect scope for file, skipping", { file: event.file })
      return
    }
    debounceReload(event.file, scope, targets)
  }

  let autoReloadStarted = false

  export function startAutoReload() {
    if (autoReloadStarted) return
    autoReloadStarted = true
    GlobalBus.on("event", (event) => {
      if (event.payload?.type !== "global.config.file.changed") return
      const properties = event.payload.properties as { file: string; event: string } | undefined
      if (!properties) return
      handleGlobalConfigEvent(properties)
    })
    reloadLog.info("auto-reload listener started")
  }
}
