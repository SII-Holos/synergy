import { RuntimeContext } from "../../lifecycle/context"
import { Log } from "../../util/log"
import { ProviderRetryCoordinator, providerRetryKey } from "../../provider/retry-coordinator"
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
import { Storage } from "../../storage/storage"
import { StoragePath } from "../../storage/path"
import { Identifier } from "../../id/id"
import { SessionManager } from "../manager"
import { RolloutRecordingError } from "../rollout/error"
import { RolloutTransport } from "../rollout/transport"

export namespace AgentTurn {
  export type Input = AgentTurnInput
  export type Stream = AgentTurnStream
  export type InProcessStream = (input: Input) => Promise<Stream>

  const runtimeState = RuntimeContext.state(() => ({
    recovery: new ProviderRetryCoordinator(),
    pool: undefined as AgentWorkerPool | undefined,
    options: DEFAULT_AGENT_WORKER_POOL_OPTIONS,
    accepting: true,
    stopPromise: undefined as Promise<void> | undefined,
    inProcessStream: undefined as InProcessStream | undefined,
  }))

  const log = Log.create({ service: "agent.turn" })
  export function configure(input: Partial<AgentWorkerPoolOptions> = {}): void {
    const instanceState = runtimeState()

    if (instanceState.pool) throw new Error("Agent worker pool cannot be reconfigured after it has started")
    instanceState.accepting = true
    instanceState.recovery = new ProviderRetryCoordinator()
    instanceState.options = {
      ...DEFAULT_AGENT_WORKER_POOL_OPTIONS,
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
    }
  }
  export function setInProcessStream(hook: InProcessStream | undefined): void {
    const instanceState = runtimeState()

    instanceState.inProcessStream = hook
  }

  export function closeAdmission(): void {
    const instanceState = runtimeState()

    instanceState.accepting = false
    instanceState.recovery.close()
  }

  export function resize(size: number): void {
    const instanceState = runtimeState()

    if (!Number.isInteger(size) || size <= 0) {
      throw new Error("Agent worker pool size must be a positive integer")
    }
    instanceState.options = { ...instanceState.options, size }
    instanceState.pool?.resize(size)
  }

  export function prewarm(): void {
    const instanceState = runtimeState()

    if (!instanceState.accepting || instanceState.stopPromise || instanceState.inProcessStream) return
    try {
      instanceState.pool ??= new AgentWorkerPool(instanceState.options)
    } catch (error) {
      // Option validation cannot succeed in any later attempt either; log it
      // and let the first turn surface the failure through lazy creation.
      log.warn("agent worker pool prewarm rejected the configured options", { error })
    }
  }

  export async function stream(input: Input): Promise<Stream> {
    const instanceState = runtimeState()

    if (!instanceState.accepting || instanceState.stopPromise) throw new Error("Agent worker pool is stopping")
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
    const prepared = instanceState.inProcessStream
      ? undefined
      : await LLM.prepare({
          ...turnInput,
          tools: ToolCatalog.modelTools(input.toolDefinitions ?? []),
        })
    try {
      return await instanceState.recovery.stream(providerRetryKey(input.model, prepared?.provider), input.abort, () =>
        RolloutCall.stream(
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
                modelSelection: input.modelSelection,
              }),
            ),
          },
          async (archive) => {
            if (!instanceState.accepting || instanceState.stopPromise) throw new Error("Agent worker pool is stopping")
            if (instanceState.inProcessStream)
              return RolloutTransport.provide(archive, () => instanceState.inProcessStream!(input))
            instanceState.pool ??= new AgentWorkerPool(instanceState.options)
            const result = await instanceState.pool.run({ ...turnInput, prepared: prepared!, archive })
            const contextUsageDraft = startContextUsageDraft(input, prepared!.system, contextUsageProvenance)
            return { ...result, contextUsageDraft }
          },
          () => {
            if (attribution.owner.kind === "session")
              SessionManager.signalAbort(attribution.owner.sessionID, { rootID: attribution.runID })
          },
        ),
      )
    } catch (error) {
      if (RolloutRecordingError.isInstance(error) && attribution.owner.kind === "session") {
        SessionManager.signalAbort(attribution.owner.sessionID, { rootID: attribution.runID })
      }
      throw error
    }
  }

  export function stats() {
    const instanceState = runtimeState()

    return (
      instanceState.pool?.stats() ?? {
        configured: instanceState.options.size,
        minIdle: instanceState.options.minIdle,
        idleTimeoutMs: instanceState.options.idleTimeoutMs,
        maxQueued: instanceState.options.maxQueued,
        maxQueuedBytes: instanceState.options.maxQueuedBytes,
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
    const instanceState = runtimeState()

    closeAdmission()
    if (instanceState.stopPromise) return instanceState.stopPromise
    const current = instanceState.pool
    instanceState.stopPromise = (async () => {
      await current?.stop()
      if (instanceState.pool === current) instanceState.pool = undefined
    })()
    try {
      await instanceState.stopPromise
    } finally {
      instanceState.stopPromise = undefined
    }
  }
}
