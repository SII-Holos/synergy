import { Agenda, AgendaBootstrap } from "@/agenda"
import { ChannelOutbound } from "@/channel/outbound"
import { registerProviders } from "@/channel/provider"
import { ResponseCardRuntime } from "@/channel/response-card"
import { Channel } from "@/channel"
import { Config } from "@/config/config"
import { CortexConcurrency } from "@/cortex/concurrency"
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
import { Embedding } from "@/vector/embedding"
import { AgentTurn } from "@/session/agent-turn"
import { DEFAULT_AGENT_WORKER_POOL_OPTIONS } from "@/session/agent-turn/worker-pool"
import { DEFAULT_TOOL_TASK_SCHEDULER_OPTIONS, ToolScheduler } from "@/session/tool-scheduler"
import { PolicyWorker, DEFAULT_POLICY_WORKER_POOL_OPTIONS } from "@/enforcement/policy-worker"
import { resolveRuntimeShutdownTimeoutMs } from "@ericsanchezok/synergy-util/runtime-shutdown"

export namespace GlobalRuntime {
  const log = Log.create({ service: "global-runtime" })
  let started: Promise<void> | undefined
  let configuredShutdownTimeoutMs = resolveRuntimeShutdownTimeoutMs(DEFAULT_AGENT_WORKER_POOL_OPTIONS.cancelGraceMs)

  export async function start() {
    if (!started) {
      started = ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          log.info("starting")
          await Plugin.init()
          const config = await Config.globalResolved().catch(async (error) => {
            // Fuse: a config load failure must never prevent the server from
            // starting. Fall back to defaults and surface the issue through
            // the diagnostics registry (visible in the startup banner and
            // GET /config/diagnostics).
            const message = error instanceof Error ? error.message : String(error)
            log.error("config load failed, starting with defaults", { error: message })
            Config.recordIssue({
              path: "config",
              error: message,
              code: "config.load_failed",
              quarantined: false,
              timestamp: Date.now(),
            })
            return Config.Info.parse({})
          })
          configuredShutdownTimeoutMs = resolveRuntimeShutdownTimeoutMs(
            Math.max(
              config.execution?.agentCancelGraceMs ?? DEFAULT_AGENT_WORKER_POOL_OPTIONS.cancelGraceMs,
              config.execution?.policyCancelGraceMs ?? DEFAULT_POLICY_WORKER_POOL_OPTIONS.cancelGraceMs,
              config.execution?.toolCancelGraceMs ?? DEFAULT_TOOL_TASK_SCHEDULER_OPTIONS.shutdownGraceMs ?? 0,
            ),
          )
          CortexConcurrency.configure(config.cortex?.maxConcurrentTasks)
          AgentTurn.configure({
            size: config.execution?.agentWorkers,
            minIdle: config.execution?.agentWorkerMinIdle,
            idleTimeoutMs: config.execution?.agentWorkerIdleTimeoutMs,
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
            idleBaselineRecycle: config.execution?.agentWorkerIdleBaselineRecycle,
            idleBaselineRssGrowthBytes:
              config.execution?.agentWorkerIdleBaselineRssGrowthMb === undefined
                ? undefined
                : config.execution.agentWorkerIdleBaselineRssGrowthMb * 1024 * 1024,
            idleBaselineExternalGrowthBytes:
              config.execution?.agentWorkerIdleBaselineExternalGrowthMb === undefined
                ? undefined
                : config.execution.agentWorkerIdleBaselineExternalGrowthMb * 1024 * 1024,
            cancelGraceMs: config.execution?.agentCancelGraceMs,
            heartbeatTimeoutMs: config.execution?.agentHeartbeatTimeoutMs,
          })
          PolicyWorker.configure({
            size: config.execution?.policyWorkers,
            maxQueued: config.execution?.policyQueueMax,
            maxQueuedBytes:
              config.execution?.policyQueueMaxMb === undefined
                ? undefined
                : config.execution.policyQueueMaxMb * 1024 * 1024,
            timeoutMs: config.execution?.policyTimeoutMs,
            maxRequests: config.execution?.policyWorkerMaxRequests,
            maxRssBytes:
              config.execution?.policyWorkerMaxRssMb === undefined
                ? undefined
                : config.execution.policyWorkerMaxRssMb * 1024 * 1024,
            maxHeapBytes:
              config.execution?.policyWorkerMaxHeapMb === undefined
                ? undefined
                : config.execution.policyWorkerMaxHeapMb * 1024 * 1024,
            cancelGraceMs: config.execution?.policyCancelGraceMs,
            heartbeatTimeoutMs: config.execution?.policyHeartbeatTimeoutMs,
          })
          void PolicyWorker.start().catch((error) => {
            log.warn("policy worker prewarm failed", { error })
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
          await LatticeRuntime.init()
          ActivitySummary.init()
          await SessionInvoke.resumePending({ scopeID: Scope.home().id })
          await ResponseCardRuntime.pruneExpired().catch((error) => {
            log.warn("response-card expired registration cleanup failed", { error })
          })
          await startChannels(config)
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

  export function shutdownTimeoutMs(): number {
    return configuredShutdownTimeoutMs
  }

  export function closeAdmission(): void {
    AgentTurn.closeAdmission()
    PolicyWorker.closeAdmission()
    ToolScheduler.closeAdmission()
  }

  export async function stop() {
    closeAdmission()
    const executionStop = Promise.all([AgentTurn.stop(), PolicyWorker.stop(), ToolScheduler.stop()])
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
    registerProviders()
    ChannelOutbound.init({ getProvider: Channel.getProvider })
    const channels = cfg.channel ?? {}
    if (Object.keys(channels).length === 0) return
    await Channel.init()
  }
}
