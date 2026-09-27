import { RuntimeReloadContributions } from "@ericsanchezok/synergy-harness/config/reload-contributions"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

export function registerReload() {
  RuntimeReloadContributions.register({
    id: "connections",
    targets: {
      async channel(ctx) {
        const [{ Channel }, { registerProviders }, { ChannelOutbound }] = await Promise.all([
          import("./channel"),
          import("./channel/provider"),
          import("./channel/outbound"),
        ])
        registerProviders()
        ChannelOutbound.init({ getProvider: Channel.getProvider })
        await Channel.reload()
        return
      },
      async holos(ctx) {
        const { HolosRuntime } = await import("./holos/runtime")
        await HolosRuntime.reload()
        return
      },
    },
    async configChanged(change, ctx) {
      const { changedFields, oldConfig, scope: resolvedScope } = change
      const result = change
      if (resolvedScope === "global" && changedFields.includes("channel")) {
        const oldAccounts = oldConfig.channel?.feishu?.accounts
        const newAccounts = result.config.channel?.feishu?.accounts
        if (JSON.stringify(oldAccounts) !== JSON.stringify(newAccounts)) {
          try {
            const { BossRuntime } = await import("@ericsanchezok/synergy-workflows/boss/boss-runtime")
            await BossRuntime.sync(result.config.boss?.enabled === true)
          } catch (err) {
            ctx.warnings.push(
              `Failed to sync runtime boss mode after channel change: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
      }
    },
  })
}
