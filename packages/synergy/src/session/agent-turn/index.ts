import { LLM } from "../llm"
import { ToolCatalog } from "../tool-catalog"
import {
  AgentWorkerPool,
  DEFAULT_AGENT_WORKER_POOL_OPTIONS,
  type AgentTurnInput,
  type AgentTurnStream,
  type AgentTurnStreamPart,
  type AgentWorkerPoolOptions,
} from "./worker-pool"
import { AgentTurnProtocol } from "./protocol"

export namespace AgentTurn {
  export type Input = AgentTurnInput
  export type Stream = AgentTurnStream

  let pool: AgentWorkerPool | undefined
  let options = DEFAULT_AGENT_WORKER_POOL_OPTIONS
  let accepting = true
  let stopPromise: Promise<void> | undefined

  export function configure(input: Partial<AgentWorkerPoolOptions> = {}): void {
    if (pool) throw new Error("Agent worker pool cannot be reconfigured after it has started")
    accepting = true
    options = {
      ...DEFAULT_AGENT_WORKER_POOL_OPTIONS,
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
    }
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
    if (process.env.SYNERGY_TEST_HOME) {
      const result = await LLM.stream({
        ...input,
        tools: ToolCatalog.modelTools(input.toolDefinitions ?? []),
      })
      const usage = result.usage?.catch(() => undefined) ?? Promise.resolve(undefined)
      if (!result.fullStream) {
        if (!result.textStream && result.text) {
          return {
            fullStream: (async function* () {
              const text = await result.text
              if (text) yield { type: "text-delta", id: "test-text", text } as AgentTurnStreamPart
            })(),
            contextUsageDraft: result.contextUsageDraft,
            usage,
            async dispose() {},
          }
        }
        const owned = LLM.takeTextStream(result)
        return {
          fullStream: (async function* () {
            for await (const text of owned.stream) {
              yield { type: "text-delta", id: "test-text", text } as AgentTurnStreamPart
            }
          })(),
          contextUsageDraft: result.contextUsageDraft,
          usage,
          dispose: owned.dispose,
        }
      }
      const owned = LLM.takeFullStream(result)
      return {
        fullStream: (async function* () {
          for await (const value of owned.stream) {
            yield* AgentTurnProtocol.projectEvents([value])
          }
        })(),
        contextUsageDraft: result.contextUsageDraft,
        usage,
        dispose: owned.dispose,
      }
    }
    pool ??= new AgentWorkerPool(options)
    const prepared = await LLM.prepare({
      ...input,
      tools: ToolCatalog.modelTools(input.toolDefinitions ?? []),
    })
    return pool.run({ ...input, prepared })
  }

  export async function collectText(stream: Stream): Promise<string> {
    let result = ""
    try {
      for await (const part of stream.fullStream) {
        if (part.type === "text-delta") result += part.text
      }
      return result
    } finally {
      await stream.dispose()
    }
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
      }
    )
  }

  export async function stop(): Promise<void> {
    if (stopPromise) return stopPromise
    accepting = false
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
