import path from "path"
import { existsSync } from "fs"
import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { GlobalBus } from "../bus/global"
import { Config } from "../config/config"
import { ConfigSet } from "../config/set"
import { Global } from "../global"
import { Instance } from "../scope/instance"
import { RuntimeSchema } from "./schema"
import { SkillPaths } from "../skill/paths"
import { Log } from "../util/log"

export namespace RuntimeReload {
  export const Target = RuntimeSchema.ReloadTarget
  export type Target = RuntimeSchema.ReloadTarget

  export const Scope = RuntimeSchema.ReloadScope
  export type Scope = RuntimeSchema.ReloadScope

  export const Result = RuntimeSchema.ReloadResult
  export type Result = RuntimeSchema.ReloadResult

  const CONFIG_RESTART_REQUIRED = new Set(["server", "logLevel", "email"])
  const BUILTIN_SOURCE_RESTART_WARNING =
    "Runtime reload refreshes runtime state only. Source edits under packages/synergy/src still require restarting the backend process to load new built-in module code."
  const CONFIG_LIVE_APPLIED = new Set([
    "model",
    "nano_model",
    "mini_model",
    "mid_model",
    "thinking_model",
    "long_context_model",
    "creative_model",
    "holos_friend_reply_model",
    "vision_model",
    "default_agent",
    "username",
    "category",
    "compaction",
    "snapshot",
    "agora",
    "instructions",
    "autoupdate",
    "enterprise",
    "tools",
    "identity",
    "external_agent",
  ])
  const CONFIG_CLIENT_SIDE = new Set(["theme", "keybinds", "layout"])

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
    plugin: ["tool_registry"],
  }

  // ─── Core reload function ────────────────────────────────────────────

  export async function reload(input: Input): Promise<Result> {
    const params = Input.parse(input)
    const requested = normalizeTargets(params.targets)
    const executed = [] as Target[]
    const failed = [] as string[]
    const warnings = [] as string[]
    const changedFields = new Set<string>()
    const restartRequired = new Set<string>()
    const liveApplied = new Set<string>()

    // P2: Centralized Config cache invalidation — all subsystems that read
    // Config.get() during their state() initialization will get fresh config.
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

    for (const target of targetsToExecute) {
      await executeTarget(target, ctx)
    }

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
    }

    GlobalBus.emit("event", {
      directory: Instance.directory,
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
    failed: string[]
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
        for (const cascade of cascades) {
          await executeTarget(cascade, ctx)
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.failed.push(target)
      ctx.warnings.push(`Failed to reload ${target}: ${message}`)
      reloadLog.error("target reload failed", { target, error: err instanceof Error ? err : new Error(message) })
    }
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
          }
        }
        // Infer cascades from changed config fields
        for (const cascadedTarget of inferConfigCascades(result.changedFields)) {
          await executeTarget(cascadedTarget, ctx)
        }
        // P11: Handle identity → autonomy/anima sync (migrated from Config.reload)
        if (result.changedFields.includes("identity") && result.oldConfig) {
          const oldAutonomy = result.oldConfig.identity?.autonomy !== false
          const newAutonomy = result.config.identity?.autonomy !== false
          if (oldAutonomy !== newAutonomy) {
            try {
              const { AgendaBootstrap } = await import("../agenda/bootstrap")
              await AgendaBootstrap.syncAnima(newAutonomy)
            } catch (err) {
              ctx.warnings.push(
                `Failed to sync anima after identity change: ${err instanceof Error ? err.message : String(err)}`,
              )
            }
          }
        }
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
        return
      }
      case "mcp": {
        const { MCP } = await import("../mcp")
        await MCP.reload()
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
        const { Command } = await import("../skill/command")
        await Command.reload()
        return
      }
      case "tool_registry": {
        const { ToolRegistry } = await import("../tool/registry")
        await ToolRegistry.reload()
        return
      }
      case "skill": {
        const { Skill } = await import("../skill/skill")
        await Skill.reload()
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
    const candidates = [
      path.join(Instance.directory, ".synergy", "synergy.jsonc"),
      path.join(Instance.directory, ".synergy", "synergy.json"),
      path.join(Instance.directory, "synergy.jsonc"),
      path.join(Instance.directory, "synergy.json"),
    ]
    return candidates.some((candidate) => existsSync(candidate))
  }

  // ─── Config cascade inference ────────────────────────────────────────
  // P10: Ensured all config fields cascade correctly.
  // - model role changes → provider + agent (model may reference unloaded provider)
  // - category changes → provider + agent (category.model may reference different provider)
  // - default_agent, instructions → agent
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
      "holos_friend_reply_model",
      "vision_model",
    ].some((field) => changed.has(field))
    if (roleModelChanged) {
      // Model role changes may reference providers not yet loaded in cached state
      cascaded.push("provider", "agent")
    }
    if (changed.has("category")) {
      // Category configs can specify model overrides that reference different providers
      cascaded.push("provider", "agent")
    }
    if (changed.has("agent") || changed.has("permission") || changed.has("identity") || changed.has("external_agent")) {
      cascaded.push("agent")
    }
    if (changed.has("default_agent") || changed.has("instructions")) {
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

    return unique(cascaded)
  }

  // ─── File path detection (shared between scope + target) ─────────────
  // P3: Unified path classification used by both detectScopeForFile and
  // detectTargetsForFile so they always agree.

  export function builtinSourceEditWarning(filePath: string) {
    const normalized = path.resolve(filePath)
    const builtinRoot = path.resolve(path.join(Instance.directory, "packages", "synergy", "src"))
    if (!normalized.startsWith(builtinRoot + path.sep)) return undefined
    return BUILTIN_SOURCE_RESTART_WARNING
  }

  // Shared directory roots used by both scope and target detection
  function globalConfigRoots() {
    return {
      agent: [
        path.resolve(path.join(Global.Path.config, "agent")),
        path.resolve(path.join(Global.Path.config, "agents")),
      ],
      command: [
        path.resolve(path.join(Global.Path.config, "command")),
        path.resolve(path.join(Global.Path.config, "commands")),
      ],
      skill: SkillPaths.runtimeSkillRootsSync(Instance.directory).filter(
        (root) => !root.startsWith(path.resolve(Instance.directory)),
      ),
      tool: [path.resolve(path.join(Global.Path.config, "tool"))],
      plugin: [
        path.resolve(path.join(Global.Path.config, "plugin")),
        path.resolve(path.join(Global.Path.config, "plugins")),
      ],
    }
  }

  function projectConfigRoots() {
    return {
      agent: [
        path.resolve(path.join(Instance.directory, ".synergy", "agent")),
        path.resolve(path.join(Instance.directory, ".synergy", "agents")),
      ],
      command: [
        path.resolve(path.join(Instance.directory, ".synergy", "command")),
        path.resolve(path.join(Instance.directory, ".synergy", "commands")),
      ],
      skill: SkillPaths.runtimeSkillRootsSync(Instance.directory).filter((root) =>
        root.startsWith(path.resolve(Instance.directory)),
      ),
      tool: [path.resolve(path.join(Instance.directory, ".synergy", "tool"))],
      plugin: [
        path.resolve(path.join(Instance.directory, ".synergy", "plugin")),
        path.resolve(path.join(Instance.directory, ".synergy", "plugins")),
      ],
    }
  }

  function isUnderRoots(normalized: string, roots: string[]): boolean {
    return roots.some((root) => normalized.startsWith(root + path.sep))
  }

  export function detectScopeForFile(filePath: string): Scope | undefined {
    const normalized = path.resolve(filePath)

    // Check global config files
    const globalFiles = [
      ConfigSet.defaultFilePath(),
      path.join(Global.Path.config, "synergy.json"),
      ConfigSet.metadataPath(),
    ].map((item) => path.resolve(item))
    if (globalFiles.includes(normalized)) return "global"

    // Check ConfigSet files
    const configSetRoot = path.resolve(ConfigSet.directory())
    if (normalized.startsWith(configSetRoot + path.sep)) {
      const relative = path.relative(configSetRoot, normalized)
      const parts = relative.split(path.sep)
      if (parts.length >= 2 && parts[parts.length - 1] === "synergy.jsonc") {
        return parts[0] === ConfigSet.activeNameSync() ? "global" : undefined
      }
    }

    // Check project config files
    const projectFiles = [
      path.join(Instance.directory, ".synergy", "synergy.jsonc"),
      path.join(Instance.directory, ".synergy", "synergy.json"),
      path.join(Instance.directory, "synergy.jsonc"),
      path.join(Instance.directory, "synergy.json"),
    ].map((item) => path.resolve(item))
    if (projectFiles.includes(normalized)) return "project"

    // P3: Check global config directory roots (agent, command, skill, tool, plugin)
    const globalRoots = globalConfigRoots()
    const allGlobalRoots = [
      ...globalRoots.agent,
      ...globalRoots.command,
      ...globalRoots.skill,
      ...globalRoots.tool,
      ...globalRoots.plugin,
    ]
    if (isUnderRoots(normalized, allGlobalRoots)) return "global"

    // P3: Check project config directory roots
    const projectRoots = projectConfigRoots()
    const allProjectRoots = [
      ...projectRoots.agent,
      ...projectRoots.command,
      ...projectRoots.skill,
      ...projectRoots.tool,
      ...projectRoots.plugin,
    ]
    if (isUnderRoots(normalized, allProjectRoots)) return "project"

    return undefined
  }

  export function detectTargetsForFile(filePath: string): Target[] {
    const normalized = path.resolve(filePath)
    const targets = [] as Target[]

    // Config files
    const configFiles = [
      ConfigSet.defaultFilePath(),
      path.join(Global.Path.config, "synergy.json"),
      ConfigSet.metadataPath(),
      path.join(Instance.directory, ".synergy", "synergy.jsonc"),
      path.join(Instance.directory, ".synergy", "synergy.json"),
      path.join(Instance.directory, "synergy.jsonc"),
      path.join(Instance.directory, "synergy.json"),
    ].map((item) => path.resolve(item))
    if (configFiles.includes(normalized)) {
      targets.push("config")
    }

    // ConfigSet files
    const configSetRoot = path.resolve(ConfigSet.directory())
    if (normalized.startsWith(configSetRoot + path.sep)) {
      const relative = path.relative(configSetRoot, normalized)
      const parts = relative.split(path.sep)
      if (parts.length >= 2 && parts[parts.length - 1] === "synergy.jsonc") {
        const setName = parts[0]
        if (setName === ConfigSet.activeNameSync()) {
          targets.push("config")
        }
      }
    }

    const gRoots = globalConfigRoots()
    const pRoots = projectConfigRoots()

    // Skill files
    const skillRoots = [...gRoots.skill, ...pRoots.skill]
    if (
      normalized.endsWith(`${path.sep}SKILL.md`) &&
      skillRoots.some((root) => normalized === root || normalized.startsWith(root + path.sep))
    ) {
      targets.push("skill")
    }

    // Agent markdown files
    const agentRoots = [...gRoots.agent, ...pRoots.agent]
    if (normalized.endsWith(".md") && isUnderRoots(normalized, agentRoots)) {
      targets.push("config", "agent")
    }

    // Command markdown files
    const commandRoots = [...gRoots.command, ...pRoots.command]
    if (normalized.endsWith(".md") && isUnderRoots(normalized, commandRoots)) {
      targets.push("config", "command")
    }

    // Custom tool files
    const toolRoots = [...gRoots.tool, ...pRoots.tool]
    if ([".ts", ".js"].includes(path.extname(normalized)) && isUnderRoots(normalized, toolRoots)) {
      targets.push("tool_registry")
    }

    // P4: Plugin files
    const pluginRoots = [...gRoots.plugin, ...pRoots.plugin]
    if ([".ts", ".js"].includes(path.extname(normalized)) && isUnderRoots(normalized, pluginRoots)) {
      targets.push("config", "plugin", "tool_registry")
    }

    return unique(targets)
  }

  function normalizeTargets(targets: Target[]) {
    return unique(targets.filter((target): target is Target => target !== undefined))
  }

  function unique<T>(items: T[]) {
    return [...new Set(items)]
  }

  // ─── Auto-reload (file watcher integration) ─────────────────────────

  const reloadLog = Log.create({ service: "runtime.reload.auto" })
  const DEFAULT_DEBOUNCE_MS = 500

  // P12: Debounce per scope rather than per file.
  // Multiple file changes within the same scope during the debounce window
  // are merged into a single reload with the union of their targets.
  let debounceTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; targets: Set<Target> }>()

  function debounceReload(file: string, scope: "global" | "project", targets: Target[]) {
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
