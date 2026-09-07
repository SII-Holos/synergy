import { Agenda } from "@/agenda"
import { AgendaBootstrap } from "@/agenda/bootstrap"
import { ChannelOutbound } from "@/channel/outbound"
import { registerProviders } from "@/channel/provider"
import { ResponseCardRuntime } from "@/channel/response-card"
import { Channel } from "@/channel"
import { Config } from "@/config/config"
import { HolosRuntime } from "@/holos/runtime"
import { PluginMarketplaceRegistry } from "@/plugin/marketplace-registry"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { FileWatcher } from "@/file/watcher"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { Log } from "@/util/log"
import { SessionRecovery } from "@/session/recovery"
import { SessionInvoke } from "@/session/invoke"
import { ActivitySummary } from "@/session/activity-summary"
import { LatticeRuntime } from "@/lattice/runtime"
import { PushBridge } from "@/push/bridge"

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
          await AgendaBootstrap.seed()
          const { BossRuntime } = await import("@/boss/boss-runtime")
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
