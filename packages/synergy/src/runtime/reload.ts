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
  ])
  const CONFIG_CLIENT_SIDE = new Set(["theme", "keybinds", "layout"])

  export const Event = {
    Reloaded: BusEvent.define(
      "runtime.reloaded",
      z.object({
        executed: z.array(Target),
        cascaded: z.array(Target),
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

  export async function reload(input: Input): Promise<Result> {
    const params = Input.parse(input)
    const requested = normalizeTargets(params.targets)
    const executed = [] as Target[]
    const warnings = [] as string[]
    const changedFields = new Set<string>()
    const restartRequired = new Set<string>()
    const liveApplied = new Set<string>()

    if (requested.includes("all")) {
      const expanded = normalizeTargets([
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
      for (const target of expanded) {
        await executeTarget(
          target,
          params.scope ?? "auto",
          executed,
          changedFields,
          restartRequired,
          liveApplied,
          warnings,
        )
      }
    } else {
      for (const target of requested) {
        await executeTarget(
          target,
          params.scope ?? "auto",
          executed,
          changedFields,
          restartRequired,
          liveApplied,
          warnings,
        )
      }
    }

    const executedSet = new Set(executed)
    const cascaded = executed.filter((target) => !requested.includes(target))
    if (requested.includes("tool_registry") || requested.includes("all")) {
      warnings.push(BUILTIN_SOURCE_RESTART_WARNING)
    }
    if (changedFields.has("experimental") && !executedSet.has("mcp")) {
      warnings.push("experimental.mcp_timeout changes do not currently trigger MCP.reload() automatically")
    }
    if (changedFields.has("tools") && !changedFields.has("permission") && !executedSet.has("agent")) {
      warnings.push(
        "legacy top-level tools config may require agent reload semantics beyond current Config.reload() mapping",
      )
    }

    const result: Result = {
      success: true,
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
        },
      },
    })

    return result
  }

  async function executeTarget(
    target: Target,
    scope: Scope,
    executed: Target[],
    changedFields: Set<string>,
    restartRequired: Set<string>,
    liveApplied: Set<string>,
    warnings: string[],
  ) {
    if (executed.includes(target)) return

    switch (target) {
      case "config": {
        const resolvedScope = resolveConfigScope(scope)
        const result = await Config.reload(resolvedScope)
        executed.push("config")
        for (const field of result.changedFields) {
          changedFields.add(field)
          if (CONFIG_RESTART_REQUIRED.has(field)) restartRequired.add(field)
          if (CONFIG_LIVE_APPLIED.has(field)) liveApplied.add(field)
          if (CONFIG_CLIENT_SIDE.has(field)) {
            warnings.push(`Config field \`${field}\` is client-side and is not reloaded by the server runtime`)
          }
        }
        for (const cascadedTarget of inferConfigCascades(result.changedFields)) {
          if (!executed.includes(cascadedTarget)) executed.push(cascadedTarget)
        }
        return
      }
      case "provider": {
        const { Provider } = await import("../provider/provider")
        await Provider.reload()
        executed.push("provider")
        await executeTarget("agent", scope, executed, changedFields, restartRequired, liveApplied, warnings)
        return
      }
      case "agent": {
        const { Agent } = await import("../agent/agent")
        await Agent.reload()
        executed.push("agent")
        return
      }
      case "plugin": {
        const { Plugin } = await import("../plugin")
        await Plugin.reload()
        executed.push("plugin")
        await executeTarget("tool_registry", scope, executed, changedFields, restartRequired, liveApplied, warnings)
        return
      }
      case "mcp": {
        const { MCP } = await import("../mcp")
        await MCP.reload()
        executed.push("mcp")
        await executeTarget("command", scope, executed, changedFields, restartRequired, liveApplied, warnings)
        return
      }
      case "lsp": {
        const { LSP } = await import("../lsp")
        await LSP.reload()
        executed.push("lsp")
        return
      }
      case "formatter": {
        const { Format } = await import("../file/format")
        await Format.reload()
        executed.push("formatter")
        return
      }
      case "watcher": {
        const { FileWatcher } = await import("../file/watcher")
        await FileWatcher.reload()
        executed.push("watcher")
        return
      }
      case "channel": {
        const { Channel } = await import("../channel")
        await Channel.reload()
        executed.push("channel")
        return
      }
      case "holos": {
        const { HolosRuntime } = await import("../holos/runtime")
        await HolosRuntime.reload()
        executed.push("holos")
        return
      }
      case "command": {
        const { Command } = await import("../skill/command")
        await Command.reload()
        executed.push("command")
        return
      }
      case "tool_registry": {
        const { ToolRegistry } = await import("../tool/registry")
        await ToolRegistry.reload()
        executed.push("tool_registry")
        return
      }
      case "skill": {
        const { Skill } = await import("../skill/skill")
        await Skill.reload()
        executed.push("skill")
        return
      }
      case "all":
        return
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

  export function builtinSourceEditWarning(filePath: string) {
    const normalized = path.resolve(filePath)
    const builtinRoot = path.resolve(path.join(Instance.directory, "packages", "synergy", "src"))
    if (!normalized.startsWith(builtinRoot + path.sep)) return undefined
    return BUILTIN_SOURCE_RESTART_WARNING
  }

  export function detectScopeForFile(filePath: string): Scope | undefined {
    const normalized = path.resolve(filePath)
    const globalFiles = [
      ConfigSet.defaultFilePath(),
      path.join(Global.Path.config, "synergy.json"),
      ConfigSet.metadataPath(),
    ].map((item) => path.resolve(item))
    if (globalFiles.includes(normalized)) return "global"

    const configSetRoot = path.resolve(ConfigSet.directory())
    if (normalized.startsWith(configSetRoot + path.sep)) {
      const relative = path.relative(configSetRoot, normalized)
      const parts = relative.split(path.sep)
      if (parts.length >= 2 && parts[parts.length - 1] === "synergy.jsonc") {
        return parts[0] === ConfigSet.activeNameSync() ? "global" : undefined
      }
    }

    const projectFiles = [
      path.join(Instance.directory, ".synergy", "synergy.jsonc"),
      path.join(Instance.directory, ".synergy", "synergy.json"),
      path.join(Instance.directory, "synergy.jsonc"),
      path.join(Instance.directory, "synergy.json"),
    ].map((item) => path.resolve(item))
    if (projectFiles.includes(normalized)) return "project"

    return undefined
  }

  export function detectTargetsForFile(filePath: string): Target[] {
    const normalized = path.resolve(filePath)
    const targets = [] as Target[]
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

    const skillRoots = SkillPaths.runtimeSkillRootsSync(Instance.directory)
    if (
      normalized.endsWith(`${path.sep}SKILL.md`) &&
      skillRoots.some((root) => normalized === root || normalized.startsWith(root + path.sep))
    ) {
      targets.push("skill")
    }

    const toolRoots = [path.join(Instance.directory, ".synergy", "tool"), path.join(Global.Path.config, "tool")].map(
      (item) => path.resolve(item),
    )
    if (
      [".ts", ".js"].includes(path.extname(normalized)) &&
      toolRoots.some((root) => normalized.startsWith(root + path.sep))
    ) {
      targets.push("tool_registry")
    }

    return unique(targets)
  }

  function normalizeTargets(targets: Target[]) {
    return unique(targets.filter((target): target is Target => target !== undefined))
  }

  function inferConfigCascades(fields: string[]) {
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
    if (changed.has("agent") || changed.has("permission") || changed.has("identity") || roleModelChanged) {
      cascaded.push("agent")
    }
    if (changed.has("plugin")) {
      cascaded.push("plugin", "tool_registry")
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

  function unique<T>(items: T[]) {
    return [...new Set(items)]
  }
}
