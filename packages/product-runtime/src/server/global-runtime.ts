import { Agenda } from "@ericsanchezok/synergy-workflows/agenda"
import { AnimaSchedule } from "../runtime/anima-schedule"
import { ChannelOutbound } from "@ericsanchezok/synergy-connections/channel/outbound"
import { registerProviders } from "@ericsanchezok/synergy-connections/channel/provider"
import { ResponseCardRuntime } from "@ericsanchezok/synergy-connections/channel/response-card"
import { Channel } from "@ericsanchezok/synergy-connections/channel"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { HolosRuntime } from "@ericsanchezok/synergy-connections/holos/runtime"
import { PluginMarketplaceRegistry } from "@ericsanchezok/synergy-plugin-host/plugin/marketplace-registry"
import { MCP } from "@ericsanchezok/synergy-agent-integrations/mcp"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { FileWatcher } from "@ericsanchezok/synergy-runtime-local/file/watcher"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { SessionRecovery } from "@ericsanchezok/synergy-harness/session/recovery"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { ActivitySummary } from "@ericsanchezok/synergy-harness/session/activity-summary"
import { LatticeRuntime } from "@ericsanchezok/synergy-workflows/lattice/runtime"
import { PushBridge } from "@ericsanchezok/synergy-workbench/push/bridge"

export namespace GlobalRuntime {
  const log = Log.create({ service: "global-runtime" })
  let started: Promise<void> | undefined
  let disposePushBridge: (() => void) | undefined

  export async function start(config: Config.Info) {
    if (!started) {
      started = ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          log.info("starting")
          await SessionRecovery.reconcileRuntimeState({ scopeID: Scope.home().id, apply: true }).catch((error) => {
            log.warn("session runtime recovery failed", { scopeID: Scope.home().id, error })
          })
          await LatticeRuntime.init()
          ActivitySummary.init()
          await SessionInvoke.resumePending({ scopeID: Scope.home().id })
          await ResponseCardRuntime.pruneExpired().catch((error) => {
            log.warn("response-card expired registration cleanup failed", { error })
          })
          await startChannels(config)
          disposePushBridge = PushBridge.init()
          await HolosRuntime.init()
          FileWatcher.init()
          MCP.ensureStarted()
          PluginMarketplaceRegistry.prefetchRegistry()
          await Agenda.start()
          await AnimaSchedule.seed()
          const { BossRuntime } = await import("@ericsanchezok/synergy-workflows/boss/boss-runtime")
          await BossRuntime.ensure().catch((error) => {
            log.warn("runtime boss provisioning failed", { error })
          })
          log.info("started")
        },
      })
    }
    return started
  }

  export async function stop() {
    Agenda.stop()
    // Stop accepting new pushes and wait for queued fan-outs before the
    // storage/services they rely on are torn down.
    if (disposePushBridge) {
      disposePushBridge()
      disposePushBridge = undefined
    }
    await PushBridge.flush().catch(() => undefined)
    await Promise.all([
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          await Channel.stopAll().catch(() => undefined)
        },
      }),
    ])
    started = undefined
  }

  async function startChannels(cfg: Config.Info) {
    registerProviders()
    ChannelOutbound.init({ getProvider: Channel.getProvider })
    const channels = cfg.channel ?? {}
    if (Object.keys(channels).length === 0) return
    await Channel.init()
  }
}
