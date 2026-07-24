import { Agenda, AgendaBootstrap } from "@/agenda"
import { ChannelOutbound } from "@/channel/outbound"
import { registerProviders } from "@/channel/provider"
import { Channel } from "@/channel"
import { Config } from "@/config/config"
import { CortexConcurrency } from "@/cortex/concurrency"
import { HolosRuntime } from "@/holos/runtime"
import { GitHubRuntime } from "@/github/runtime"
import { GitHubPollRuntime } from "@/github/poll-runtime"
import { PluginMarketplaceRegistry } from "@/plugin/marketplace-registry"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { FileWatcher } from "@/file/watcher"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { Log } from "@/util/log"
import { SessionRecovery } from "@/session/recovery"
import { SessionInvoke } from "@/session/invoke"
import { Embedding } from "@/vector/embedding"
import { AgentTurn } from "@/session/agent-turn"
import { ToolScheduler } from "@/session/tool-scheduler"

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
          AgentTurn.configure({
            size: config.execution?.agentWorkers,
            maxQueued: config.execution?.agentQueueMax,
            maxQueuedBytes:
              config.execution?.agentQueueMaxMb === undefined
                ? undefined
                : config.execution.agentQueueMaxMb * 1024 * 1024,
            maxTurns: config.execution?.agentWorkerMaxTurns,
            maxRssBytes:
              config.execution?.agentWorkerMaxRssMb === undefined
                ? undefined
                : config.execution.agentWorkerMaxRssMb * 1024 * 1024,
            maxHeapBytes:
              config.execution?.agentWorkerMaxHeapMb === undefined
                ? undefined
                : config.execution.agentWorkerMaxHeapMb * 1024 * 1024,
            cancelGraceMs: config.execution?.agentCancelGraceMs,
            heartbeatTimeoutMs: config.execution?.agentHeartbeatTimeoutMs,
          })
          ToolScheduler.configure({
            maxConcurrent: config.execution?.toolConcurrency,
            maxQueued: config.execution?.toolQueueMax,
            maxQueuedBytes:
              config.execution?.toolQueueMaxMb === undefined
                ? undefined
                : config.execution.toolQueueMaxMb * 1024 * 1024,
            shutdownGraceMs: config.execution?.toolCancelGraceMs,
            executorConcurrency: config.execution?.toolExecutorConcurrency,
          })
          await SessionRecovery.reconcileRuntimeState({ scopeID: Scope.home().id, apply: true }).catch((error) => {
            log.warn("session runtime recovery failed", { scopeID: Scope.home().id, error })
          })
          await startChannels(config)
          await HolosRuntime.init()
          FileWatcher.init()
          MCP.ensureStarted()
          PluginMarketplaceRegistry.prefetchRegistry()
          await SessionInvoke.resumePending()
          await Agenda.start()
          await AgendaBootstrap.seed()
          await GitHubRuntime.start(config.github)
          await GitHubPollRuntime.start(config.github)
          log.info("started")
        },
      })
    }
    return started
  }

  export async function stop() {
    const executionStop = Promise.all([AgentTurn.stop(), ToolScheduler.stop()])
    await GitHubPollRuntime.stop()
    await GitHubRuntime.stop()
    Agenda.stop()
    await executionStop
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
