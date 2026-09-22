import { RuntimeContext } from "../lifecycle/context"
import { Log } from "../util/log"
import { ContinuationKernel } from "./continuation-kernel"
import { SessionInbox } from "./inbox"
import { SessionLifecycle } from "./lifecycle"
import { SessionManager } from "./manager"

export namespace SessionDrive {
  const log = Log.create({ service: "session.drive" })
  const runtimeState = RuntimeContext.state(() => ({
    inflight: new Map<string, Promise<boolean>>(),
  }))

  export interface RequestOptions {
    waitForProcessing?: boolean
    /**
     * Drive this session even if discovery finds no work.
     *
     * Reserved for an explicit user action (`session.continue`), where the
     * decision to resume has already been made and the discovery heuristics
     * cannot see it: the shared continuation gate requires a *terminal*
     * assistant on the latest reply-required root, while an interrupted turn is
     * deliberately non-terminal, so a plain request would be a silent no-op —
     * exactly the case a user most wants to resume.
     *
     * It cannot manufacture work: the loop exits before its first model call
     * when the session has nothing left to do.
     */
    force?: boolean
  }

  export async function request(sessionID: string, reason: string, options?: RequestOptions): Promise<boolean> {
    const instanceState = runtimeState()

    const previous = instanceState.inflight.get(sessionID)
    const arbitration = previous
      ? previous.then(
          () => arbitrate(sessionID, reason, options?.force === true),
          () => arbitrate(sessionID, reason, options?.force === true),
        )
      : arbitrate(sessionID, reason, options?.force === true)
    const tracked = arbitration.finally(() => {
      if (instanceState.inflight.get(sessionID) === tracked) instanceState.inflight.delete(sessionID)
    })
    instanceState.inflight.set(sessionID, tracked)

    const handled = await tracked
    if (!handled || SessionManager.isRunning(sessionID)) return handled
    if (options?.waitForProcessing) {
      await SessionManager.wake(sessionID, { force: options?.force === true })
    } else {
      SessionManager.scheduleWake(sessionID, reason)
    }
    return true
  }

  export function reset(): void {
    const instanceState = runtimeState()

    instanceState.inflight.clear()
  }

  /**
   * The single gate every automatic drive passes through.
   *
   * Two rules are enforced here rather than at each call site, because a missed
   * call site is a silent regression that restarts work the user stopped:
   *
   * 1. A paused interactive session is never driven. This check runs *before*
   *    discovery on purpose: if it ran after, a paused session with queued work
   *    would report `handled = true` and wake, defeating the pause.
   * 2. A forced request skips discovery only. The running and pause checks still
   *    apply, so forcing can resume work but cannot bypass a stop.
   */
  async function arbitrate(sessionID: string, reason: string, force: boolean): Promise<boolean> {
    if (SessionManager.isRunning(sessionID)) return false
    if (await isPaused(sessionID)) return false
    if (!force) {
      if (await SessionInbox.hasRunnableItem(sessionID)) return true
      const proposal = await ContinuationKernel.propose(sessionID)
      if (!proposal) return false
      if (proposal.kind === "handled") return true
      return deliver(sessionID, reason, proposal)
    }
    return true
  }

  async function deliver(
    sessionID: string,
    reason: string,
    proposal: ContinuationKernel.InboxProposal,
  ): Promise<boolean> {
    const deliveryKey = proposal.deliveryKey
    if (!deliveryKey) {
      log.error("continuation proposal missing delivery key", { sessionID, reason })
      return false
    }
    await SessionInbox.deliverUnique({
      sessionID,
      deliveryKey,
      mode: proposal.mode,
      message: proposal.message,
    })
    await ContinuationKernel.markCommitted(sessionID, proposal)
    return SessionInbox.hasRunnableItem(sessionID)
  }

  /** Whether the pause latch forbids automatic driving of this session. */
  async function isPaused(sessionID: string): Promise<boolean> {
    const session = await SessionManager.getSession(sessionID).catch(() => undefined)
    return SessionLifecycle.blocksDrive(session)
  }
}
