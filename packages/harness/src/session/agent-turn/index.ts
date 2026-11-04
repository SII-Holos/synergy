import { ContextUsage } from "../context-usage"
import { RuntimeContext } from "../../lifecycle/context"
import { ObservabilitySpans } from "../../observability/spans"
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
import { materializeAttachmentInput } from "../../attachment/model-input"
import { ModelExecution } from "../../execution/model-execution"
import { InProcessModelExecutor } from "./model-executor"
import { SecretMask } from "../../secrets/mask"
import { RuntimeResources } from "../../resources/runtime"
import { ResourceCosts } from "../../resources/costs"
import { sessionResourceOwner } from "../../resources/owner"
import { ExecutionCapacity } from "../execution-capacity"
import { LLMTurnMemory } from "../llm-memory"

export namespace AgentTurn {
  export type Input = AgentTurnInput
  export type Stream = AgentTurnStream
  export type InProcessStream = (input: Input) => Promise<Stream>

  const runtimeState = RuntimeContext.state(() => ({
    recovery: new ProviderRetryCoordinator(),
    costs: new ResourceCosts(),
    pool: undefined as AgentWorkerPool | InProcessModelExecutor | undefined,
    options: DEFAULT_AGENT_WORKER_POOL_OPTIONS,
    accepting: true,
    stopPromise: undefined as Promise<void> | undefined,
    inProcessStream: undefined as InProcessStream | undefined,
    unsubscribeResources: undefined as (() => void) | undefined,
    warming: undefined as Promise<void> | undefined,
    warmAbort: undefined as AbortController | undefined,
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
    RuntimeResources.setLimit("model", instanceState.options.size, instanceState.options)
  }
  export function setInProcessStream(hook: InProcessStream | undefined): void {
    const instanceState = runtimeState()

    instanceState.inProcessStream = hook
  }

  export function closeAdmission(): void {
    const instanceState = runtimeState()

    instanceState.accepting = false
    instanceState.warmAbort?.abort()
    instanceState.recovery.close()
  }

  export function resize(size: number): void {
    const instanceState = runtimeState()

    if (!Number.isInteger(size) || size <= 0) {
      throw new Error("Agent worker pool size must be a positive integer")
    }
    instanceState.options = { ...instanceState.options, size }
    RuntimeResources.setLimit("model", size, instanceState.options)
    instanceState.pool?.resize(size)
  }

  export function prewarm(): Promise<void> {
    const instanceState = runtimeState()

    if (
      !instanceState.accepting ||
      instanceState.stopPromise ||
      instanceState.inProcessStream ||
      ModelExecution.mode() === "in-process" ||
      RuntimeResources.status().queued > 0 ||
      RuntimeResources.status().state !== "normal"
    )
      return Promise.resolve()
    if (instanceState.warming) return instanceState.warming
    const current = instanceState.pool?.stats()
    const missing = Math.max(
      0,
      Math.min(instanceState.options.size, (current?.active ?? 0) + instanceState.options.minIdle) -
        (current?.workers ?? 0),
    )
    const bytes = missing * instanceState.costs.startup()
    if (!missing) return Promise.resolve()
    if (RuntimeResources.status().headroomBytes < bytes) return Promise.resolve()
    const abort = new AbortController()
    instanceState.warmAbort = abort
    instanceState.warming = RuntimeResources.allocation(
      { owner: "worker-prewarm", bytes, signal: abort.signal },
      async () => {
        if (!instanceState.accepting) return
        instanceState.pool ??= createExecutor(instanceState.options)
        if (instanceState.pool instanceof AgentWorkerPool) {
          instanceState.pool.setPressure(false)
          await instanceState.pool.waitForWarm(abort.signal)
        }
      },
    )
      .catch((error) => {
        if (!abort.signal.aborted) log.warn("agent worker prewarm failed", { error })
      })
      .finally(() => {
        instanceState.warming = undefined
        instanceState.warmAbort = undefined
      })
    return instanceState.warming
  }

  export async function prepare(request: Input): Promise<Input & { prepared: LLM.PreparedTurn }> {
    return RuntimeResources.allocation(
      {
        owner:
          request.recording?.owner.kind === "operation"
            ? request.sessionID
            : await sessionResourceOwner(request.sessionID),
        bytes: preparationBytes(request),
        signal: request.abort,
      },
      () => prepareAdmitted(request),
    )
  }

  async function prepareAdmitted(request: Input): Promise<Input & { prepared: LLM.PreparedTurn }> {
    const input = { ...request, messages: await materializeAttachmentInput(request.messages, request.abort) }
    return {
      ...input,
      prepared:
        input.prepared ?? (await LLM.prepare({ ...input, tools: ToolCatalog.modelTools(input.toolDefinitions) })),
    }
  }

  export async function stream(request: Input): Promise<Stream> {
    const instanceState = runtimeState()

    if (!instanceState.accepting || instanceState.stopPromise) throw new Error("Agent worker pool is stopping")
    const owner =
      request.recording?.owner.kind === "operation" ? request.sessionID : await sessionResourceOwner(request.sessionID)
    request.onPhase?.("waiting_resources")
    const input = request.prepared
      ? request
      : instanceState.inProcessStream
        ? await RuntimeResources.allocation(
            { owner, bytes: preparationBytes(request), signal: request.abort },
            async () => ({ ...request, messages: await materializeAttachmentInput(request.messages, request.abort) }),
          )
        : await prepare(request)
    if (input.promptSuffix) input.promptSuffix = await SecretMask.apply(input.promptSuffix)
    const userMetadata = input.user.metadata
      ? JSON.parse(await SecretMask.apply(JSON.stringify(input.user.metadata)))
      : undefined
    const { contextUsageProvenance, recording, usageRole, retryIndex, onPhase, recovery, ...turnInput } = input
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
    const prepared =
      input.prepared ??
      (instanceState.inProcessStream
        ? undefined
        : await ObservabilitySpans.measure(
            { name: "session.prepare.model_input", module: "session", kind: "session", sessionID: input.sessionID },
            () => LLM.prepare({ ...turnInput, tools: ToolCatalog.modelTools(input.toolDefinitions ?? []) }),
          ))
    const requestTools = (input.toolDefinitions ?? []).filter(
      (tool) => !input.activeToolIDs || input.activeToolIDs.includes(tool.id),
    )
    const provenance = contextUsageProvenance
      ? ContextUsage.buildProvenance({
          history: ContextUsage.remapProvenance(input.messages, contextUsageProvenance),
          toolDefinitions: requestTools,
        })
      : undefined
    const lease = await instanceState.recovery.acquire(
      providerRetryKey(input.model, prepared?.provider),
      input.abort,
      recovery,
    )
    let cost = executionCost(input)
    const resource = await ExecutionCapacity.wait(() =>
      RuntimeResources.acquire({
        owner,
        pool: "model",
        bytes: cost.startup + cost.turn,
        estimate: () => {
          cost = executionCost(input)
          return cost.startup + cost.turn
        },
        retainedBytes: LLMTurnMemory.estimateBytes(input),
        signal: input.abort,
      }),
    ).catch((error) => {
      lease.release()
      throw error
    })
    let owned: Stream | undefined
    const own = (source: Stream): Stream => {
      let disposed: Promise<void> | undefined
      owned = {
        ...source,
        dispose: () =>
          (disposed ??= (async () => {
            // Rollout disposal can replay a provider error after the executor has acknowledged release.
            await source.dispose()
            await RuntimeResources.sampleAfterAllocation()
            resource.release()
          })()),
      }
      return owned
    }
    try {
      const result = await RolloutCall.stream(
        {
          ...attribution,
          usageRole: usageRole ?? "auxiliary",
          retryIndex,
          agent: input.agent.name,
          model: {
            providerID: input.model.providerID,
            modelID: input.model.id,
            apiModelID: input.model.api?.id,
            sdk: input.model.api?.npm ?? "unknown",
            pricing: input.model.pricing ?? null,
            billingMode: input.model.billingMode ?? "unknown",
            limits: input.model.limit,
          },
          request: JSON.parse(
            JSON.stringify({
              userMetadata,
              messages: input.messages,
              system: prepared?.system ?? input.system,
              lateSystem: input.lateSystem,
              promptSuffix: input.promptSuffix,
              contextSources: provenance
                ? ContextUsage.sourceIndex({
                    messages: input.messages,
                    system: prepared?.system ?? input.system,
                    lateSystem: input.lateSystem,
                    provenance,
                  })
                : undefined,
              tools: requestTools,
              toolChoice: input.toolChoice,
              params: prepared
                ? {
                    temperature: prepared.params.temperature,
                    topP: prepared.params.topP,
                    topK: prepared.params.topK,
                  }
                : undefined,
              maxOutputTokens: input.maxOutputTokens,
              modelSelection: input.modelSelection,
            }),
          ),
        },
        (archive) =>
          lease.stream(async () => {
            if (!instanceState.accepting || instanceState.stopPromise) throw new Error("Agent worker pool is stopping")
            if (instanceState.inProcessStream) {
              onPhase?.("waiting_model")
              return own(
                await RolloutTransport.provide(archive, () =>
                  instanceState.inProcessStream!({ ...input, contextUsageProvenance: provenance }),
                ),
              )
            }
            instanceState.pool ??= createExecutor(instanceState.options)
            if (instanceState.pool instanceof AgentWorkerPool)
              instanceState.pool.setPressure(RuntimeResources.status().state !== "normal")
            onPhase?.("queued_agent")
            const result = await instanceState.pool.run({ ...turnInput, prepared: prepared!, archive, onPhase })
            const contextUsageDraft = startContextUsageDraft(input, prepared!.system, provenance)
            return own({ ...result, contextUsageDraft })
          }),
        () => {
          if (attribution.owner.kind === "session")
            SessionManager.signalAbort(attribution.owner.sessionID, { rootID: attribution.runID })
        },
      )
      if (cost.startup) {
        await RuntimeResources.sampleAfterAllocation()
        resource.checkpoint(cost.turn)
      }
      return result
    } catch (error) {
      lease.release()
      if (RolloutRecordingError.isInstance(error) && attribution.owner.kind === "session") {
        SessionManager.signalAbort(attribution.owner.sessionID, { rootID: attribution.runID })
      }
      if (owned) {
        try {
          await owned.dispose()
        } catch (disposalError) {
          throw new AggregateError([error, disposalError], "Model startup and disposal failed")
        }
      } else {
        await RuntimeResources.sampleAfterAllocation()
        resource.release()
      }
      throw error
    }
  }

  export function stats() {
    const instanceState = runtimeState()

    const stats = instanceState.pool?.stats() ?? {
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
    return { ...stats, ...RuntimeResources.poolStatus("model") }
  }

  export async function stop(): Promise<void> {
    const instanceState = runtimeState()

    closeAdmission()
    if (instanceState.stopPromise) return instanceState.stopPromise
    const current = instanceState.pool
    instanceState.stopPromise = (async () => {
      await current?.stop()
      await instanceState.warming
      instanceState.unsubscribeResources?.()
      instanceState.unsubscribeResources = undefined
      if (instanceState.pool === current) instanceState.pool = undefined
    })()
    try {
      await instanceState.stopPromise
    } finally {
      instanceState.stopPromise = undefined
    }
  }

  function createExecutor(options: AgentWorkerPoolOptions) {
    if (ModelExecution.mode() === "in-process") return new InProcessModelExecutor(options)
    const pool = new AgentWorkerPool(options, undefined, {}, runtimeState().costs)
    pool.setPressure(RuntimeResources.status().state !== "normal")
    runtimeState().unsubscribeResources = RuntimeResources.subscribe((status) => {
      if (status.state !== "normal") pool.setPressure(true)
      else if (pool.stats().workers < Math.min(options.size, pool.stats().active + options.minIdle)) void prewarm()
    })
    return pool
  }

  function preparationBytes(input: Input) {
    return 64 * 1024 ** 2 + 4 * LLMTurnMemory.estimateBytes(input.messages)
  }

  function executionCost(input: Input) {
    const current = runtimeState()
    const stats = current.pool?.stats()
    const starting =
      ModelExecution.mode() === "in-process" || current.inProcessStream
        ? 0
        : Math.max(
            0,
            Math.min(current.options.size, RuntimeResources.poolStatus("model").active + 1) - (stats?.workers ?? 0),
          )
    return {
      startup: starting * current.costs.startup(),
      turn: current.costs.turn(
        LLMTurnMemory.estimateBytes({
          messages: input.messages,
          prepared: input.prepared,
          tools: input.toolDefinitions,
        }),
      ),
    }
  }
}
