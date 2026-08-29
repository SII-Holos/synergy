import { ToolPluginSource } from "../tool/plugin-source"
import { Plugin } from "./index"
import { getPluginConfig, matchesPluginSettingCondition } from "./config-store"
import { PluginToolId } from "./ids.js"
import { ensureRuntime, type LoadedPlugin } from "./loader"
import { pluginRuntimeManager } from "./runtime"
import { Log } from "../util/log"

const log = Log.create({ service: "plugin.tool-source" })

/**
 * S9d source inversion: the L1 tool registry loads plugin tool contributions
 * and evaluates their setting conditions through this registered source
 * instead of importing the plugin product domain. Loaded through
 * src/product-registration.ts.
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
    inputSchema: contribution.input,
    exposure: contribution.exposure as ToolPluginSource.Entry["exposure"],
    display: contribution.display as ToolPluginSource.Entry["display"],
    enabledWhen: contribution.enabledWhen,
    async execute(args, ctx) {
      await ensureRuntime(plugin)
      return pluginRuntimeManager.invoke({
        pluginId: plugin.id,
        handlerId: `tool:${contribution.id}`,
        value: args,
        context: {
          scopeId: ctx.scopeId,
          sessionId: ctx.sessionID,
          directory: ctx.directory,
          actor: {
            type: "agent",
            agent: ctx.agent,
            messageId: ctx.messageID,
            callId: ctx.callID ?? `${plugin.id}:${contribution.id}`,
            userMessageId: ctx.userMessageID,
          },
        },
        pluginDir: plugin.pluginDir,
        manifest: plugin.manifest,
        signal: ctx.abort,
      })
    },
  }
}
