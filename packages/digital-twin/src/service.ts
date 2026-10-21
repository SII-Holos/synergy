import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionContextSnapshot } from "@ericsanchezok/synergy-harness/session/context-snapshot"
import { SessionCorpus } from "@ericsanchezok/synergy-harness/session/corpus"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { AgentCall } from "@ericsanchezok/synergy-harness/agent/call"
import { DigitalTwinContract } from "./contract"
import { collect } from "./evidence"
import { infer, PredictionError } from "./inference"
import { representatives, useCorpus, stopPreparation } from "./preparation"
import "./config-schema"

type Flight = { controller: AbortController; consumers: number; result: Promise<DigitalTwinContract.Result> }
const state = RuntimeContext.state(() => ({
  closed: false,
  flights: new Map<string, Flight>(),
  operations: new Set<Promise<unknown>>(),
  running: new Set<Flight>(),
}))

export namespace DigitalTwin {
  export function predictNextInput(
    input: DigitalTwinContract.Input & { signal?: AbortSignal },
  ): Promise<DigitalTwinContract.Result> {
    const instance = state()
    const operation = predict(input).finally(() => instance.operations.delete(operation))
    instance.operations.add(operation)
    return operation
  }

  async function predict(input: DigitalTwinContract.Input & { signal?: AbortSignal }) {
    const instance = state()
    if (instance.closed || input.signal?.aborted) throw new PredictionError("cancelled", "Prediction cancelled")
    DigitalTwinContract.Input.parse({
      sessionID: input.sessionID,
      requestID: input.requestID,
      expected: input.expected,
    })
    const snapshot = await SessionContextSnapshot.capture({
      sessionID: input.sessionID,
      expected: input.expected,
      signal: input.signal,
    }).catch((error) => {
      if (error instanceof SessionContextSnapshot.UnavailableError)
        throw new PredictionError("source_unavailable", error.message, { cause: error })
      throw error
    })
    if (snapshot.stamp.scopeID !== ScopeContext.current.scope.id)
      throw new PredictionError("source_unavailable", "The Session belongs to another Scope")
    const configuration = (await Config.current()).digitalTwin
    if (instance.closed || input.signal?.aborted) throw new PredictionError("cancelled", "Prediction cancelled")
    const selectedModel = configuration?.model ?? snapshot.model
    const identity = JSON.stringify([snapshot.stamp.scopeID, input.sessionID, snapshot.stamp.revision, selectedModel])
    let flight = instance.flights.get(identity)
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController()
      const result = (async () => {
        const model = await Provider.getModel(selectedModel.providerID, selectedModel.modelID).catch((error) => {
          throw new PredictionError("model_unavailable", "The selected prediction model is unavailable", {
            cause: error,
          })
        })
        useCorpus(snapshot.stamp)
        const prepared = await representatives()
        const current = await MessageV2.toModelMessage(snapshot.messages)
        const evidence = await collect({
          current: JSON.stringify(current),
          representatives: prepared.references,
          sessionID: input.sessionID,
          signal: controller.signal,
        })
        const result = await infer({
          current,
          evidence,
          statistics: prepared.statistics,
          model,
          signal: controller.signal,
          metadata: {
            source: "digital-twin",
            sourceSessionID: input.sessionID,
            sourceRootID: snapshot.stamp.rootID,
            sourceAssistantID: snapshot.stamp.assistantID,
            requestID: input.requestID,
          },
        })
        controller.signal.throwIfAborted()
        const latestConfig = (await Config.current()).digitalTwin?.model ?? snapshot.model
        if (
          JSON.stringify(latestConfig) !== JSON.stringify(selectedModel) ||
          !(await SessionContextSnapshot.isCurrent(snapshot.stamp)) ||
          !(await Storage.snapshot(async () => {
            const revisions = await Storage.revisions(prepared.sources.map((source) => source.key))
            return (
              prepared.sources.every((source, index) => source.revision === (revisions[index]?.toString() ?? null)) &&
              (await SessionCorpus.current(result.selected.flatMap((item) => item.references)))
            )
          }))
        )
          throw new PredictionError("source_changed", "The conversation or selected evidence changed")
        const { sources: ignoredSources, ...stamp } = snapshot.stamp
        return {
          proposalID: crypto.randomUUID(),
          candidate: result.prediction.candidate,
          abstention: result.prediction.abstention,
          stamp: { ...stamp, model: selectedModel },
        }
      })().finally(() => {
        instance.running.delete(running)
        if (instance.flights.get(identity) === running) instance.flights.delete(identity)
      })
      const running: Flight = { controller, consumers: 0, result }
      flight = running
      instance.flights.set(identity, flight)
      instance.running.add(flight)
    }
    const owned = flight
    owned.consumers++
    let abort: (() => void) | undefined
    try {
      return await Promise.race([
        owned.result,
        new Promise<never>((_, reject) => {
          abort = () => reject(new PredictionError("cancelled", "Prediction cancelled"))
          if (input.signal?.aborted) abort()
          else input.signal?.addEventListener("abort", abort, { once: true })
        }),
      ])
    } catch (error) {
      if (input.signal?.aborted || (error instanceof AgentCall.Error && error.code === "cancelled"))
        throw new PredictionError("cancelled", "Prediction cancelled", { cause: error })
      throw error
    } finally {
      if (abort) input.signal?.removeEventListener("abort", abort)
      if (--owned.consumers === 0) owned.controller.abort()
    }
  }

  export async function close() {
    const instance = state()
    instance.closed = true
    for (const flight of instance.running) flight.controller.abort()
    await Promise.allSettled([...instance.operations, ...[...instance.running].map((flight) => flight.result)])
    await stopPreparation()
  }
}
