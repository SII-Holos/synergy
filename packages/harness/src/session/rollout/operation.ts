import { Experiment } from "../../config/experiment"
import type z from "zod"
import { Scope } from "../../scope"
import { ScopeContext } from "../../scope/context"
import { SessionManager } from "../manager"
import { RolloutContext } from "./context"
import { RolloutCall } from "./call"
import { RolloutLedger } from "./ledger"
import { findRecordingError } from "./error"
import type { RolloutSchema } from "./schema"

export namespace RolloutOperation {
  type Json = z.infer<ReturnType<typeof z.json>>
  export async function execute<T>(
    input: {
      purpose: string
      kind?: RolloutSchema.CallRecord["kind"]
      execution?: RolloutSchema.CallRecord["execution"]
      model: z.infer<typeof RolloutSchema.Model>
      request: Json | ((owner: RolloutSchema.Owner) => Promise<Json>)
      independent?: boolean
    },
    action: () => Promise<{ value: T; response: Json; usage?: Json }>,
  ) {
    const inherited = input.independent ? undefined : RolloutContext.current()
    const id = crypto.randomUUID()
    const identity = inherited ?? {
      owner: { kind: "operation" as const, scopeID: ScopeContext.tryScope()?.id ?? Scope.home().id, operationID: id },
      runID: id,
    }
    let segment: RolloutSchema.ExecutionSegment | undefined
    let status: "completed" | "failed" | "cancelled" = "failed"
    let failure: unknown
    try {
      await RolloutLedger.beginRun(identity.owner, identity.runID)
      const configuration = await Experiment.resolve()
      if (!inherited) await RolloutLedger.configureRun(identity.owner, identity.runID, configuration)
      const request =
        typeof input.request === "function"
          ? await Experiment.provide(configuration, () => {
              const prepare = input.request
              return typeof prepare === "function" ? prepare(identity.owner) : prepare
            })
          : input.request
      if (!inherited) segment = await RolloutLedger.beginSegment({ ...identity, input: request })
      const value = await Experiment.provide(configuration, () =>
        RolloutCall.execute({ ...input, ...identity, request, parentCallID: inherited?.callID }, action, () => {
          if (identity.owner.kind === "session")
            SessionManager.signalAbort(identity.owner.sessionID, { rootID: identity.runID })
        }),
      )
      status = "completed"
      return value
    } catch (error) {
      const recordingError = findRecordingError(error)
      failure = recordingError ?? error
      if (recordingError) {
        if (identity.owner.kind === "session")
          SessionManager.signalAbort(identity.owner.sessionID, { rootID: identity.runID })
        await RolloutLedger.failRecording(identity.owner, identity.runID, recordingError)
      }
      status =
        error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
          ? "cancelled"
          : "failed"
      throw failure
    } finally {
      if (!inherited) {
        try {
          if (segment) await RolloutLedger.finishSegment(segment, status)
          await RolloutLedger.finishRun(identity.owner, identity.runID, status)
        } catch (error) {
          const recordingError = findRecordingError(failure)
          if (recordingError) throw recordingError
          throw error
        }
      }
    }
  }
}
