import z from "zod"
import type { Config } from "../config/config"
import { CortexConcurrency } from "../cortex/concurrency"
import { AgentTurn } from "../session/agent-turn"
import { DEFAULT_AGENT_WORKER_POOL_OPTIONS } from "../session/agent-turn/worker-pool"
import { DEFAULT_TOOL_TASK_SCHEDULER_OPTIONS, ToolScheduler } from "../session/tool-scheduler"
import { PolicyWorker, DEFAULT_POLICY_WORKER_POOL_OPTIONS } from "../enforcement/policy-worker"
import { resolveRuntimeShutdownTimeoutMs } from "@ericsanchezok/synergy-util/runtime-shutdown"
import { availableParallelism } from "os"
import { ServiceMemory } from "../process/service-memory"
import { ObservabilityMetrics } from "../observability/metrics"

// Share of the effective memory limit the Agent worker pool may reserve. The
// remainder covers the Control Plane, the storage and telemetry workers, tool
// processes, and page cache.
const AGENT_POOL_MEMORY_UTILIZATION = 0.5
const AGENT_WORKER_CAPACITY_MAX = 64

export type AgentWorkerCapacity = {
  size: number
  source: "explicit" | "derived"
}

export function defaultAgentWorkers(
  config: Config.Info,
  mode: "server" | "oneshot",
  budget = ServiceMemory.resolveMemoryBudget(),
): number {
  const reserveBytes = Math.max(1, Math.floor(resolvedAgentWorkerMaxRssBytes(config) / 2))
  const memoryCap = Math.max(1, Math.floor((budget.limitBytes * AGENT_POOL_MEMORY_UTILIZATION) / reserveBytes))
  const cpuCap = Math.max(1, availableParallelism() - 1)
  const derived = Math.min(memoryCap, cpuCap, AGENT_WORKER_CAPACITY_MAX)
  return Math.max(1, derived, desiredAgentWorkerMinIdle(config, mode))
}

export function resolveAgentWorkerCapacity(
  config: Config.Info,
  mode: "server" | "oneshot",
  budget = ServiceMemory.resolveMemoryBudget(),
): AgentWorkerCapacity {
  const explicit = config.execution?.agentWorkers ?? undefined
  if (explicit !== undefined) return { size: explicit, source: "explicit" }
  return { size: defaultAgentWorkers(config, mode, budget), source: "derived" }
}

export const AgentWorkerCapacityStatus = z
  .object({
    configured: z
      .number()
      .int()
      .positive()
      .max(AGENT_WORKER_CAPACITY_MAX)
      .nullable()
      .describe("Explicit execution.agentWorkers ceiling, or null when the machine derives it"),
    effective: z.number().int().positive().describe("Capacity the Agent worker pool runs with"),
    source: z.enum(["explicit", "derived"]).describe("Whether configuration or the machine sizes the pool"),
  })
  .meta({ ref: "AgentWorkerCapacityStatus" })
export type AgentWorkerCapacityStatus = z.infer<typeof AgentWorkerCapacityStatus>

export function agentWorkerCapacityStatus(
  config: Config.Info,
  mode: "server" | "oneshot",
  budget = ServiceMemory.resolveMemoryBudget(),
): AgentWorkerCapacityStatus {
  const capacity = resolveAgentWorkerCapacity(config, mode, budget)
  return {
    configured: config.execution?.agentWorkers ?? null,
    effective: capacity.size,
    source: capacity.source,
  }
}

export function recordAgentPoolSize(capacity: AgentWorkerCapacity) {
  ObservabilityMetrics.record({
    name: "agent.pool.size",
    value: capacity.size,
    unit: "count",
    module: "session",
    labels: { source: capacity.source },
  })
}

export function resolvedAgentWorkerMaxRssBytes(config: Config.Info): number {
  const megabytes =
    config.execution?.agentWorkerMaxRssMb ?? DEFAULT_AGENT_WORKER_POOL_OPTIONS.maxRssBytes / (1024 * 1024)
  return megabytes * 1024 * 1024
}

export function configureExecution(config: Config.Info, mode: "server" | "oneshot") {
  const shutdownTimeoutMs = resolveRuntimeShutdownTimeoutMs(
    Math.max(
      config.execution?.agentCancelGraceMs ?? DEFAULT_AGENT_WORKER_POOL_OPTIONS.cancelGraceMs,
      config.execution?.policyCancelGraceMs ?? DEFAULT_POLICY_WORKER_POOL_OPTIONS.cancelGraceMs,
      config.execution?.toolCancelGraceMs ?? DEFAULT_TOOL_TASK_SCHEDULER_OPTIONS.shutdownGraceMs ?? 0,
    ),
  )
  const agentWorkerCapacity = resolveAgentWorkerCapacity(config, mode)
  CortexConcurrency.configure(config.cortex?.maxConcurrentTasks)
  AgentTurn.configure({
    size: agentWorkerCapacity.size,
    minIdle: resolvedAgentWorkerMinIdle(config, mode, agentWorkerCapacity.size),
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
  recordAgentPoolSize(agentWorkerCapacity)
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

export function resolveExecutionConfiguration(config: Config.Info, mode: "server" | "oneshot"): Config.Info {
  const agentWorkerCapacity = resolveAgentWorkerCapacity(config, mode)
  return {
    ...config,
    cortex: { ...config.cortex, maxConcurrentTasks: CortexConcurrency.desiredGlobalLimit() },
    execution: {
      ...config.execution,
      agentWorkers: agentWorkerCapacity.size,
      agentWorkerMinIdle: resolvedAgentWorkerMinIdle(config, mode, agentWorkerCapacity.size),
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

function desiredAgentWorkerMinIdle(config: Config.Info, mode: "server" | "oneshot"): number {
  if (config.execution?.agentWorkerMinIdle !== undefined) return config.execution.agentWorkerMinIdle
  // The warm idle reserve only pays off on a resident server; a one-shot
  // runtime exits after its last turn, so a reserved worker would never serve.
  return mode === "server" ? DEFAULT_AGENT_WORKER_POOL_OPTIONS.minIdle : 0
}

// An explicit agentWorkers wins verbatim, so the warm reserve is what gives way
// when it would exceed the ceiling: the pool rejects minIdle > size, and that
// rejection would otherwise surface at the first turn instead of here.
function resolvedAgentWorkerMinIdle(config: Config.Info, mode: "server" | "oneshot", size: number): number {
  return Math.min(desiredAgentWorkerMinIdle(config, mode), size)
}
