import { Agenda, AgendaBootstrap } from "@/agenda"
import { ChannelOutbound } from "@/channel/outbound"
import { registerProviders } from "@/channel/provider"
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

export namespace GlobalRuntime {
  const log = Log.create({ service: "global-runtime" })
  let started: Promise<void> | undefined

  export async function start() {
    if (!started) {
      started = ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          log.info("starting")
          await Plugin.init()
          await SessionRecovery.reconcileRuntimeState({ scopeID: Scope.home().id, apply: true }).catch((error) => {
            log.warn("session runtime recovery failed", { scopeID: Scope.home().id, error })
          })
          await startChannels()
          await HolosRuntime.init()
          FileWatcher.init()
          MCP.ensureStarted()
          PluginMarketplaceRegistry.prefetchRegistry()
          await Agenda.start()
          await AgendaBootstrap.seed()
          log.info("started")
        },
      })
    }
    return started
  }

  export async function stop() {
    Agenda.stop()
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await Channel.stopAll().catch(() => undefined)
      },
    })
    started = undefined
  }

  async function startChannels() {
    const cfg = await Config.globalResolved()
    const channels = cfg.channel ?? {}
    if (Object.keys(channels).length === 0) return
    registerProviders()
    await Channel.init()
    ChannelOutbound.init()
  }
}
