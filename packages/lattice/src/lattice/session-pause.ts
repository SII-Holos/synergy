import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { LatticeTypes } from "./types"

/**
 * Projects a Run's own pause state onto its session.
 *
 * The session is the single pause authority, so `RunStatus.paused` is a machine
 * gate and never a second pause control: a Run stopped by one (an exhausted
 * budget, a lost BlueprintLoop, a workflow conflict) is reported as *the
 * session* waiting for the user, and the latch is released as soon as the Run no
 * longer holds the session. `user_exit` is excluded in both directions —
 * leaving a workflow cancels it rather than pausing the session.
 */
export namespace LatticeSessionPause {
  const log = Log.create({ service: "lattice.session-pause" })

  /** Latch the session for a machine pause. A Run paused by the user exiting
   * the workflow is a cancellation, so it never writes a session pause. */
  export async function pauseSession(sessionID: string, reason: string | undefined): Promise<void> {
    if (!reason || reason === "user_exit") return
    await SessionLifecycle.pause({
      sessionID,
      reason: "workflow",
      description: `Lattice run paused: ${reason.replaceAll("_", " ")}`,
    }).catch((error) => {
      log.warn("lattice session pause projection failed", { sessionID, error: String(error) })
      return false
    })
  }

  /** Release the latch Lattice wrote, preserving a pause the session owns for a
   * reason of its own. */
  export async function releaseSession(sessionID: string): Promise<void> {
    const paused = await SessionLifecycle.snapshot(sessionID).catch(() => undefined)
    if (paused?.reason !== "workflow") return
    await SessionLifecycle.clear(sessionID).catch((error) => {
      log.warn("lattice session pause release failed", { sessionID, error: String(error) })
      return false
    })
  }

  /** Keep the session latch in step with a committed Run transition. */
  export async function sync(previous: LatticeTypes.Run, settled: LatticeTypes.Run): Promise<void> {
    if (settled.status === "paused") {
      if (settled.statusReason === "user_exit") await releaseSession(settled.sessionID)
      else await pauseSession(settled.sessionID, settled.statusReason)
      return
    }
    if (previous.status !== "paused") return
    await releaseSession(settled.sessionID)
  }
}
