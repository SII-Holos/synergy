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
import { RolloutCall } from "../rollout/call"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Identifier } from "@/id/id"
import { SessionManager } from "../manager"
import { RolloutRecordingError } from "../rollout/error"
import { RolloutTransport } from "../rollout/transport"

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
    const { contextUsageProvenance, recording, ...turnInput } = input
    const attribution = recording ?? {
      owner: {
        kind: "session" as const,
        scopeID: (
          await Storage.read<{ scopeID: string }>(StoragePath.sessionIndex(Identifier.asSessionID(input.sessionID)))
        ).scopeID,
        sessionID: input.sessionID,
      },
      runID: input.user.rootID ?? input.user.id,
      purpose: input.agent.name,
    }
    const prepared = inProcessStream
      ? undefined
      : await LLM.prepare({
          ...turnInput,
          tools: ToolCatalog.modelTools(input.toolDefinitions ?? []),
        })
    try {
      return await RolloutCall.stream(
        {
          ...attribution,
          agent: input.agent.name,
          model: {
            providerID: input.model.providerID,
            modelID: input.model.id,
            sdk: input.model.api?.npm ?? "unknown",
            pricing: input.model.pricing ?? null,
          },
          request: JSON.parse(
            JSON.stringify({
              messages: input.messages,
              system: prepared?.system ?? input.system,
              tools: input.toolDefinitions,
              params: prepared
                ? { temperature: prepared.params.temperature, topP: prepared.params.topP, topK: prepared.params.topK }
                : undefined,
              maxOutputTokens: input.maxOutputTokens,
            }),
          ),
        },
        async (archive) => {
          if (inProcessStream) return RolloutTransport.provide(archive, () => inProcessStream!(input))
          pool ??= new AgentWorkerPool(options)
          const result = await pool.run({ ...turnInput, prepared: prepared!, archive })
          const contextUsageDraft = startContextUsageDraft(input, prepared!.system, contextUsageProvenance)
          return { ...result, contextUsageDraft }
        },
        () => {
          if (attribution.owner.kind === "session")
            SessionManager.signalAbort(attribution.owner.sessionID, { rootID: attribution.runID })
        },
      )
    } catch (error) {
      if (RolloutRecordingError.isInstance(error) && attribution.owner.kind === "session") {
        SessionManager.signalAbort(attribution.owner.sessionID, { rootID: attribution.runID })
      }
      throw error
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
