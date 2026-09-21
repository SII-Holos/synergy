import type { PausedReason } from "./types"
import z from "zod"
import { SessionInvoke } from "./invoke"
import { SessionCortexRuntime } from "./cortex-runtime"
import { SessionManager } from "./manager"
import { SessionLifecycle } from "./lifecycle"
import { SessionInbox } from "./inbox"
import { Lock } from "../util/lock"
import { RolloutLedger } from "./rollout/ledger"
import { RolloutLifecycle } from "./rollout/lifecycle"
type AbortHook = (sessionID: string) => void | Promise<void>

export namespace SessionAbort {
  const hooks = new Set<AbortHook>()

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
      /** The session was left paused, awaiting an explicit continue. */
      paused: z.boolean().meta({ description: "The session was left paused, awaiting an explicit continue" }),
    })
    .meta({ ref: "SessionAbortResult" })
  export type Result = z.infer<typeof Result>

  export function registerHook(hook: AbortHook): () => void {
    hooks.add(hook)
    return () => hooks.delete(hook)
  }

  export interface AbortOptions {
    /**
     * A cancellation this domain owns (Lattice, Light Loop). The work stopped
     * because its owner withdrew it, not because the user asked this session to
     * hold still, so the turn is settled without latching a pause.
     */
    internalCancel?: boolean
    terminalize?: boolean
    abandonWorkflow?: boolean
    pauseReason?: PausedReason
  }

  export async function abort(sessionID: string, options?: AbortOptions): Promise<Result> {
    using control = options?.internalCancel ? undefined : await Lock.write(`session-control:${sessionID}`)
    // Sample liveness *before* the signal. The signal ends the turn, which
    // releases the runtime, so a later sample cannot distinguish a loop that was
    // healthily driving this turn from one orphaned by a dead runtime.
    const turnWasRunning = SessionManager.isRunning(sessionID)
    // A stop that leaves the session resumable must not terminalize the
    // interrupted turn: `finish:"error"` plus `time.completed` is what makes
    // `session.continue` a silent no-op, and that terminal record belongs to the
    // Abandon path alone. The intent rides on the abort signal itself, so every
    // writer that would terminalize the turn reads it from the abort it is
    // already reacting to rather than racing this call.
    //
    // Three stops keep the record, and each is a case where "stopped" really
    // does mean "over" for the thing that owns the turn: an internal
    // cancellation has withdrawn its own work, an abandon has given up on it,
    // and a session the pause latch does not apply to (unattended or a Cortex
    // delegation) is reconciled by a machine domain that reads the turn's
    // terminal record to decide between `completed` and `error`. Leaving that
    // one resumable would report a stopped task as finished instead.
    const pauseTurn =
      options?.internalCancel !== true &&
      options?.terminalize !== true &&
      options?.abandonWorkflow !== true &&
      SessionLifecycle.latchable(await SessionManager.getSession(sessionID).catch(() => undefined))
    if (!options?.internalCancel) {
      await SessionLifecycle.pause({ sessionID, reason: options?.pauseReason ?? "aborted" })
    }
    let outcome: Result["outcome"] = "idle"
    let fenced: SessionInbox.StoredItem[] = []
    if (options?.abandonWorkflow) {
      await SessionInbox.fenceQueuedWork(sessionID, (fenceQueuedBefore, items) => {
        fenced = items
        outcome = SessionInvoke.cancel(sessionID, { fenceQueuedWork: true, fenceQueuedBefore })
      })
    } else {
      outcome = SessionInvoke.cancel(sessionID, pauseTurn ? { pauseTurn: true } : undefined)
    }
    try {
      await SessionCortexRuntime.cancelAllForParent(sessionID)
      if (options?.abandonWorkflow) {
        await SessionManager.waitForIdle(sessionID)
        const session = await SessionManager.getSession(sessionID)
        for (const item of fenced) {
          if (item.mode !== "task" || !item.messageID || !session) continue
          await RolloutLedger.cancelUnopenedRun(RolloutLifecycle.owner(session), item.messageID, item.time.created)
          await RolloutLifecycle.cancel(sessionID, item.messageID)
        }
      }
      await Promise.all([...hooks].map((hook) => hook(sessionID)))
    } catch (cause) {
      if (!options?.abandonWorkflow) throw cause
      throw new SessionInvoke.AbandonError(
        { message: "Could not finish cancelling execution. The session remains paused; retry abandoning it." },
        { cause },
      )
    }
    const state = await SessionInvoke.repairAbortState(sessionID, {
      turnWasRunning,
      internalCancel: options?.internalCancel,
      terminalize: options?.terminalize,
      abandonWorkflow: options?.abandonWorkflow,
      pauseReason: options?.pauseReason,
    })
    return { outcome, repaired: state.repaired, paused: state.paused, abandoned: state.abandoned }
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
    return result.repaired || result.abandoned || result.paused
  }
}
