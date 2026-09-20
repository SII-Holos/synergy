import { RuntimeContext } from "../lifecycle/context"
import z from "zod"
import { SessionInvoke } from "./invoke"
import { SessionCortexRuntime } from "./cortex-runtime"
import { SessionManager } from "./manager"
type AbortHook = (sessionID: string) => void | Promise<void>

export namespace SessionAbort {
  const runtimeState = RuntimeContext.state(() => ({
    hooks: new Set<AbortHook>(),
  }))

  const AbortOutcomeSchema = z.enum(["not_found", "idle", "signaled", "already_stopping", "not_owner"])

  /**
   * What an abort actually did. An unconditional success cannot distinguish
   * "the running turn was stopped" from "nothing was running", which is
   * misleading for a stuck session and for an operator retrying a stop.
   */
  export const Result = z
    .object({
      /** What the runtime signal did. `not_found` and `idle` mean nothing was
       * running, so work was not stopped by this call. */
      outcome: AbortOutcomeSchema.meta({
        description: "Runtime signal result; not_found/idle mean no running turn was stopped",
      }),
      /** An interrupted turn was terminalized. */
      repaired: z.boolean().meta({ description: "An interrupted turn was terminalized" }),
      /** A workflow was terminalized because nothing durable drove it. */
      abandoned: z.boolean().meta({ description: "A driverless workflow was terminalized" }),
      /** Idle was published because this call cleared the last work. */
      settled: z.boolean().meta({ description: "The session settled to idle" }),
    })
    .meta({ ref: "SessionAbortResult" })
  export type Result = z.infer<typeof Result>

  export function registerHook(hook: AbortHook): () => void {
    const instanceState = runtimeState()

    instanceState.hooks.add(hook)
    return () => instanceState.hooks.delete(hook)
  }

  export async function abort(sessionID: string, options?: { recoverQueuedTasks?: boolean }): Promise<Result> {
    const instanceState = runtimeState()

    // Sample liveness *before* the signal. The signal ends the turn, which
    // releases the runtime, so a later sample cannot distinguish a loop that was
    // healthily driving this turn from one orphaned by a dead runtime.
    const turnWasRunning = SessionManager.isRunning(sessionID)
    const outcome = SessionInvoke.cancel(sessionID, options)
    await SessionCortexRuntime.cancelAllForParent(sessionID)
    const state = await SessionInvoke.repairAbortState(sessionID, { turnWasRunning })
    await Promise.all([...instanceState.hooks].map((hook) => hook(sessionID)))
    return { outcome, repaired: state.repaired, abandoned: state.abandoned, settled: state.settled }
  }

  /** Whether this call had any real effect, as opposed to finding an idle
   * session with nothing to stop. A Cortex child cancellation is a real effect
   * even when the parent turn itself was idle. */
  export function hadEffect(
    result: Result,
    options: { cortexCancelled?: boolean; signalsDelivered?: boolean } = {},
  ): boolean {
    if (result.outcome === "signaled" || result.outcome === "already_stopping") return true
    // Cancelling a detached loop job or a Cortex child is real work even though
    // it is not reflected in the runtime signal outcome.
    if (options.cortexCancelled || options.signalsDelivered) return true
    return result.repaired || result.abandoned || result.settled
  }
}
