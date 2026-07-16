import { ClarusRuntime } from "@/clarus/runtime"
import { ClarusRestClient } from "@/clarus/rest-client"
import { Agenda, AgendaBootstrap } from "@/agenda"
import { ChannelOutbound } from "@/channel/outbound"
import { registerProviders } from "@/channel/provider"
import { Channel } from "@/channel"
import { Config } from "@/config/config"
import { CortexConcurrency } from "@/cortex/concurrency"
import { HolosRuntime } from "@/holos/runtime"
import { PluginMarketplaceRegistry } from "@/plugin/marketplace-registry"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { FileWatcher } from "@/file-watcher"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { Log } from "@/util/log"
import { SessionRecovery } from "@/session/recovery"
import { SessionInvoke } from "@/session/invoke"
import { Embedding } from "@/vector/embedding"

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
          const config = await Config.globalResolved()
          CortexConcurrency.configure(config.cortex?.maxConcurrentTasks)
          await SessionRecovery.reconcileRuntimeState({ scopeID: Scope.home().id, apply: true }).catch((error) => {
            log.warn("session runtime recovery failed", { scopeID: Scope.home().id, error })
          })
          await startChannels(config)
          await HolosRuntime.init()
          const clarusApiUrl = config.clarus?.apiUrl ?? config.holos?.apiUrl ?? "https://api.holosai.io"
          const clarusClient = new ClarusRestClient({
            apiUrl: clarusApiUrl,
            credentials: async () => {
              const { HolosAuth } = await import("@/holos/auth")
              const cred = await HolosAuth.getStoredCredential()
              if (!cred) return undefined
              return { agentId: cred.agentId, agentSecret: cred.agentSecret }
            },
          })
          ClarusRuntime.configureRest(clarusClient)
          await ClarusRuntime.init().catch((error) => {
            log.warn("Clarus init failed", { error })
          })
          FileWatcher.init()
          MCP.ensureStarted()
          PluginMarketplaceRegistry.prefetchRegistry()
          await SessionInvoke.resumePending()
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
    ClarusRuntime.configureRest(null)
    await Promise.all([
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          await Channel.stopAll().catch(() => undefined)
        },
      }),
      MCP.stop(),
      Embedding.dispose(),
    ])
    started = undefined
  }

  async function startChannels(cfg: Config.Info) {
    const channels = cfg.channel ?? {}
    if (Object.keys(channels).length === 0) return
    registerProviders()
    await Channel.init()
    ChannelOutbound.init()
  }
}
