import type { Config } from "@/config/config"
import { CortexConcurrency } from "@/cortex/concurrency"
import { AgentTurn } from "@/session/agent-turn"
import { DEFAULT_AGENT_WORKER_POOL_OPTIONS } from "@/session/agent-turn/worker-pool"
import { DEFAULT_TOOL_TASK_SCHEDULER_OPTIONS, ToolScheduler } from "@/session/tool-scheduler"
import { PolicyWorker, DEFAULT_POLICY_WORKER_POOL_OPTIONS } from "@/enforcement/policy-worker"
import { resolveRuntimeShutdownTimeoutMs } from "@ericsanchezok/synergy-util/runtime-shutdown"

export function configureExecution(config: Config.Info) {
  const shutdownTimeoutMs = resolveRuntimeShutdownTimeoutMs(
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
      config.execution?.agentQueueMaxMb === undefined ? undefined : config.execution.agentQueueMaxMb * 1024 * 1024,
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
      config.execution?.policyQueueMaxMb === undefined ? undefined : config.execution.policyQueueMaxMb * 1024 * 1024,
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
  ToolScheduler.configure({
    maxConcurrent: config.execution?.toolConcurrency,
    maxQueued: config.execution?.toolQueueMax,
    maxQueuedBytes:
      config.execution?.toolQueueMaxMb === undefined ? undefined : config.execution.toolQueueMaxMb * 1024 * 1024,
    shutdownGraceMs: config.execution?.toolCancelGraceMs,
    executorConcurrency: config.execution?.toolExecutorConcurrency,
  })
  return shutdownTimeoutMs
}

export function resolveExecutionConfiguration(config: Config.Info): Config.Info {
  return {
    ...config,
    cortex: { ...config.cortex, maxConcurrentTasks: CortexConcurrency.desiredGlobalLimit() },
    execution: {
      ...config.execution,
      agentWorkers: config.execution?.agentWorkers ?? DEFAULT_AGENT_WORKER_POOL_OPTIONS.size,
      agentWorkerMinIdle: config.execution?.agentWorkerMinIdle ?? DEFAULT_AGENT_WORKER_POOL_OPTIONS.minIdle,
      agentWorkerIdleTimeoutMs:
        config.execution?.agentWorkerIdleTimeoutMs ?? DEFAULT_AGENT_WORKER_POOL_OPTIONS.idleTimeoutMs,
      agentQueueMax: config.execution?.agentQueueMax ?? DEFAULT_AGENT_WORKER_POOL_OPTIONS.maxQueued,
      agentQueueMaxMb:
        config.execution?.agentQueueMaxMb ?? (DEFAULT_AGENT_WORKER_POOL_OPTIONS.maxQueuedBytes ?? 0) / (1024 * 1024),
      agentWorkerMaxTurns: config.execution?.agentWorkerMaxTurns ?? DEFAULT_AGENT_WORKER_POOL_OPTIONS.maxTurns,
      agentWorkerMaxRssMb:
        config.execution?.agentWorkerMaxRssMb ?? (DEFAULT_AGENT_WORKER_POOL_OPTIONS.maxRssBytes ?? 0) / (1024 * 1024),
      agentWorkerMaxHeapMb:
        config.execution?.agentWorkerMaxHeapMb ?? (DEFAULT_AGENT_WORKER_POOL_OPTIONS.maxHeapBytes ?? 0) / (1024 * 1024),
      agentWorkerIdleBaselineRecycle:
        config.execution?.agentWorkerIdleBaselineRecycle ?? DEFAULT_AGENT_WORKER_POOL_OPTIONS.idleBaselineRecycle,
      agentWorkerIdleBaselineRssGrowthMb:
        config.execution?.agentWorkerIdleBaselineRssGrowthMb ??
        (DEFAULT_AGENT_WORKER_POOL_OPTIONS.idleBaselineRssGrowthBytes ?? 0) / (1024 * 1024),
      agentWorkerIdleBaselineExternalGrowthMb:
        config.execution?.agentWorkerIdleBaselineExternalGrowthMb ??
        (DEFAULT_AGENT_WORKER_POOL_OPTIONS.idleBaselineExternalGrowthBytes ?? 0) / (1024 * 1024),
      agentCancelGraceMs: config.execution?.agentCancelGraceMs ?? DEFAULT_AGENT_WORKER_POOL_OPTIONS.cancelGraceMs,
      agentHeartbeatTimeoutMs:
        config.execution?.agentHeartbeatTimeoutMs ?? DEFAULT_AGENT_WORKER_POOL_OPTIONS.heartbeatTimeoutMs,
      policyWorkers: config.execution?.policyWorkers ?? DEFAULT_POLICY_WORKER_POOL_OPTIONS.size,
      policyQueueMax: config.execution?.policyQueueMax ?? DEFAULT_POLICY_WORKER_POOL_OPTIONS.maxQueued,
      policyQueueMaxMb:
        config.execution?.policyQueueMaxMb ?? (DEFAULT_POLICY_WORKER_POOL_OPTIONS.maxQueuedBytes ?? 0) / (1024 * 1024),
      policyTimeoutMs: config.execution?.policyTimeoutMs ?? DEFAULT_POLICY_WORKER_POOL_OPTIONS.timeoutMs,
      policyWorkerMaxRequests:
        config.execution?.policyWorkerMaxRequests ?? DEFAULT_POLICY_WORKER_POOL_OPTIONS.maxRequests,
      policyWorkerMaxRssMb:
        config.execution?.policyWorkerMaxRssMb ?? (DEFAULT_POLICY_WORKER_POOL_OPTIONS.maxRssBytes ?? 0) / (1024 * 1024),
      policyWorkerMaxHeapMb:
        config.execution?.policyWorkerMaxHeapMb ??
        (DEFAULT_POLICY_WORKER_POOL_OPTIONS.maxHeapBytes ?? 0) / (1024 * 1024),
      policyCancelGraceMs: config.execution?.policyCancelGraceMs ?? DEFAULT_POLICY_WORKER_POOL_OPTIONS.cancelGraceMs,
      policyHeartbeatTimeoutMs:
        config.execution?.policyHeartbeatTimeoutMs ?? DEFAULT_POLICY_WORKER_POOL_OPTIONS.heartbeatTimeoutMs,
      toolConcurrency: config.execution?.toolConcurrency ?? DEFAULT_TOOL_TASK_SCHEDULER_OPTIONS.maxConcurrent,
      toolQueueMax: config.execution?.toolQueueMax ?? DEFAULT_TOOL_TASK_SCHEDULER_OPTIONS.maxQueued,
      toolQueueMaxMb:
        config.execution?.toolQueueMaxMb ?? (DEFAULT_TOOL_TASK_SCHEDULER_OPTIONS.maxQueuedBytes ?? 0) / (1024 * 1024),
      toolCancelGraceMs: config.execution?.toolCancelGraceMs ?? DEFAULT_TOOL_TASK_SCHEDULER_OPTIONS.shutdownGraceMs,
      lspIdleReap: config.execution?.lspIdleReap ?? true,
      toolExecutorConcurrency: {
        ...DEFAULT_TOOL_TASK_SCHEDULER_OPTIONS.executorConcurrency,
        ...config.execution?.toolExecutorConcurrency,
      },
    },
  }
}
