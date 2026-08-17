import { LLM } from "../llm"
import { ToolCatalog } from "../tool-catalog"
import {
  AgentWorkerPool,
  DEFAULT_AGENT_WORKER_POOL_OPTIONS,
  type AgentTurnInput,
  type AgentTurnStream,
  type AgentWorkerPoolOptions,
} from "./worker-pool"
import { startContextUsageDraft } from "./context-usage-draft"

export namespace AgentTurn {
  export type Input = AgentTurnInput
  export type Stream = AgentTurnStream
  export type InProcessStream = (input: Input) => Promise<Stream>

  let pool: AgentWorkerPool | undefined
  let options = DEFAULT_AGENT_WORKER_POOL_OPTIONS
  let accepting = true
  let stopPromise: Promise<void> | undefined
  let inProcessStream: InProcessStream | undefined

  export function configure(input: Partial<AgentWorkerPoolOptions> = {}): void {
    if (pool) throw new Error("Agent worker pool cannot be reconfigured after it has started")
    accepting = true
    options = {
      ...DEFAULT_AGENT_WORKER_POOL_OPTIONS,
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
    }
  }
  export function setInProcessStream(hook: InProcessStream | undefined): void {
    inProcessStream = hook
  }

  export function closeAdmission(): void {
    accepting = false
  }

  export function resize(size = DEFAULT_AGENT_WORKER_POOL_OPTIONS.size): void {
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error("Agent worker pool size must be a positive integer")
    }
    options = { ...options, size }
    pool?.resize(size)
  }

  export async function stream(input: Input): Promise<Stream> {
    if (!accepting || stopPromise) throw new Error("Agent worker pool is stopping")
    if (inProcessStream) return inProcessStream(input)
    const { contextUsageProvenance, ...turnInput } = input
    pool ??= new AgentWorkerPool(options)
    const prepared = await LLM.prepare({
      ...turnInput,
      tools: ToolCatalog.modelTools(input.toolDefinitions ?? []),
    })
    const result = await pool.run({ ...turnInput, prepared })
    const contextUsageDraft = startContextUsageDraft(input, prepared.system, contextUsageProvenance)
    return { ...result, contextUsageDraft }
  }

  export function stats() {
    return (
      pool?.stats() ?? {
        configured: options.size,
        minIdle: options.minIdle,
        idleTimeoutMs: options.idleTimeoutMs,
        maxQueued: options.maxQueued,
        maxQueuedBytes: options.maxQueuedBytes,
        workers: 0,
        ready: 0,
        active: 0,
        queued: 0,
        queuedBytes: 0,
        rssBytes: 0,
        heapUsedBytes: 0,
        heapTotalBytes: 0,
        externalBytes: 0,
        arrayBuffersBytes: 0,
        baselineBytes: 0,
        peakBytes: 0,
        retainedBytes: 0,
        measuredWorkers: 0,
        lastRecovery: undefined,
      }
    )
  }

  export async function stop(): Promise<void> {
    closeAdmission()
    if (stopPromise) return stopPromise
    const current = pool
    stopPromise = (async () => {
      await current?.stop()
      if (pool === current) pool = undefined
    })()
    try {
      await stopPromise
    } finally {
      stopPromise = undefined
    }
  }
}
