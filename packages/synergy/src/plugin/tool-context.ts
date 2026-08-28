import type { GateOptions } from "../enforcement/gate"
import { Log } from "../util/log"
import { SessionToolContext } from "../session/tool-context"
import { PluginToolId } from "./ids.js"
import { toolCapabilities } from "./capability"
import { getApproval } from "./consent/approval-store"
import { markContributionDegraded, type LoadedPlugin } from "./loader"
import { Plugin } from "./index"

const log = Log.create({ service: "plugin.tool-context" })

/**
 * P9 source inversion: the L1 session tool resolver reaches plugin gate
 * data, tool hooks, and contribution degradation through this registered
 * source instead of importing the plugin product domain directly. Loaded
 * through src/product-registration.ts.
 */
export function registerPluginToolContext() {
  SessionToolContext.registerPluginSource({
    async configureGate(options: GateOptions) {
      const registeredPluginTools = new Set<string>()
      const caps: NonNullable<GateOptions["pluginToolCapabilities"]> = {}
      const approvals: NonNullable<GateOptions["pluginApprovals"]> = {}
      for (const plugin of await Plugin.getLoaded()) {
        try {
          for (const contribution of plugin.manifest.contributions) {
            if (contribution.kind !== "tool") continue
            registeredPluginTools.add(PluginToolId.format(plugin.id, contribution.id))
            caps[PluginToolId.format(plugin.id, contribution.id)] = {
              capabilities: toolCapabilities(plugin.manifest, contribution.id),
            }
          }
          const approval = await getApproval(plugin.id, plugin.manifest)
          if (approval) approvals[plugin.id] = { approvedCapabilities: approval.approvedCapabilities }
        } catch (err) {
          log.warn("plugin gate data skipped", {
            pluginId: plugin.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      options.registeredPluginTools = registeredPluginTools
      options.pluginToolCapabilities = caps
      options.pluginApprovals = approvals
    },
    triggerToolHooks(point, input, initial, options) {
      return Plugin.trigger(point, input, initial, { signal: options?.signal })
    },
    async markToolSchemaDegraded(pluginId, toolId, error) {
      const plugin: LoadedPlugin | undefined = await Plugin.get(pluginId)
      if (plugin) markContributionDegraded(plugin, { kind: "tool", id: toolId }, error)
    },
  })
}
