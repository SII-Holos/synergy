import { RuntimeReloadContributions } from "@ericsanchezok/synergy-harness/config/reload-contributions"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Plugin } from "./plugin"

export function registerReload() {
  RuntimeReloadContributions.register({
    id: "plugin-host",
    targets: {
      async plugin(ctx) {
        const { Plugin } = await import("./plugin")
        await Plugin.reload()
        await Plugin.init()
        await Plugin.runPendingInstallLifecycles({ catchUpStarted: true }).catch((error) =>
          Log.create({ service: "runtime-reload" }).warn("pending plugin install lifecycles failed", { error }),
        )
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
      },
    },
    async configChanged(change, ctx) {
      const { changedFields, oldConfig, scope: resolvedScope } = change
      const result = change
      await Plugin.notifyConfigHooks({ source: "reload", config: result.config, changedFields })
    },
  })
}
