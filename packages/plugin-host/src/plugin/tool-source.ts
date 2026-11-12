import { ToolPluginSource } from "@ericsanchezok/synergy-harness/tool/plugin-source"
import { Plugin } from "."
import { getPluginConfig, matchesPluginSettingCondition } from "./config-store"
import { PluginToolId } from "./ids.js"
import { ensureRuntime, type LoadedPlugin } from "./loader"
import { pluginRuntimeManager } from "./runtime"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutContext } from "@ericsanchezok/synergy-harness/session/rollout/context"
import { PluginInvocationWorkspace } from "./invocation-workspace"

const log = Log.create({ service: "plugin.tool-source" })

/**
 * S9d source inversion: the L1 tool registry loads plugin tool contributions
 * and evaluates their setting conditions through this registered source
 * instead of importing the plugin product domain. Loaded through
 * src/registration.ts.
 */
export function registerToolPluginSource() {
  ToolPluginSource.register({
    async toolEntries() {
      const entries: ToolPluginSource.Entry[] = []
      const plugins = await Plugin.getLoaded()
      for (const plugin of plugins) {
        try {
          for (const contribution of Plugin.contributions(plugin, "tool")) {
            entries.push(pluginToolEntry(contribution, plugin))
          }
        } catch (err) {
          log.warn("plugin tools skipped due to registry failure", {
            pluginId: plugin.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return entries
    },
    async conditionEnabled(pluginId, condition) {
      const manifest = await Plugin.manifest(pluginId)
      const values = await getPluginConfig(pluginId, { manifest })
      return matchesPluginSettingCondition(condition, values)
    },
  })
}

function pluginToolEntry(
  contribution: Extract<LoadedPlugin["manifest"]["contributions"][number], { kind: "tool" }>,
  plugin: LoadedPlugin,
): ToolPluginSource.Entry {
  const fullId = PluginToolId.format(plugin.id, contribution.id)
  return {
    fullId,
    pluginId: plugin.id,
    toolId: contribution.id,
    pluginDir: plugin.pluginDir,
    description: contribution.description,
    requiresWorkspace: contribution.requiresWorkspace,
    inputSchema: contribution.input,
    exposure: contribution.exposure as ToolPluginSource.Entry["exposure"],
    display: contribution.display as ToolPluginSource.Entry["display"],
    enabledWhen: contribution.enabledWhen,
    async execute(args, ctx) {
      const input = { ...ctx }
      input.abort.throwIfAborted()
      const rollout = RolloutContext.current()
      if (
        !input.callID ||
        rollout?.owner.kind !== "session" ||
        rollout.owner.scopeID !== input.scopeId ||
        rollout.owner.sessionID !== input.sessionID
      )
        throw new Error("Plugin Tool requires its native Session, Run and call identity")
      const callID = input.callID
      const runID = rollout.runID
      const message = await MessageV2.readInfo({
        scopeID: input.scopeId,
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      if (message.role !== "assistant" || !message.rootID)
        throw new Error("Plugin Tool requires its canonical assistant root")
      const origin = EnvironmentOrigin.selected({
        kind: "session",
        scopeID: input.scopeId,
        sessionID: input.sessionID,
        rootID: message.rootID,
        runID,
        messageID: input.messageID,
        callID,
        tool: fullId,
      })
      await EnvironmentOrigin.assertAdmission(origin, { scopeID: input.scopeId })
      return PluginInvocationWorkspace.withOrigin(origin, async () => {
        input.abort.throwIfAborted()
        await ensureRuntime(plugin)
        return pluginRuntimeManager().invoke({
          pluginId: plugin.id,
          handlerId: `tool:${contribution.id}`,
          value: args,
          context: {
            scopeId: input.scopeId,
            sessionId: input.sessionID,
            directory: input.directory,
            actor: {
              type: "agent",
              agent: input.agent,
              messageId: input.messageID,
              callId: callID,
              userMessageId: input.userMessageID,
            },
          },
          pluginDir: plugin.pluginDir,
          manifest: plugin.manifest,
          signal: input.abort,
        })
      })
    },
  }
}
