import { SessionPauseRecovery } from "./pause-recovery"
import z from "zod"
import { Log } from "../util/log"
import { SessionInteraction } from "./interaction"
import type { Info, PausedInfo, PausedReason } from "./types"

export namespace SessionLifecycle {
  const log = Log.create({ service: "session.lifecycle" })

  export const PauseInput = z.object({
    sessionID: z.string(),
    reason: z.enum(["aborted", "failed", "interrupted", "workflow"]),
    description: z.string().optional(),
  })
  export type PauseInput = z.infer<typeof PauseInput>

  /**
   * Record the pause latch for a session.
   *
   * This is the single writer of `session.paused`, and therefore the only place
   * that decides whether a session is allowed to stop mid-work. Every abnormal
   * end funnels here from the shared repair primitive so there is one definition
   * of "paused" rather than one per caller.
   *
   * Three rules make the latch trustworthy:
   *
   * - **Machine sessions never latch.** An `unattended` session is driven by a
   *   domain that reconciles its own work, so a user-facing pause would be both
   *   invisible and disobeyed. Skipping the write keeps those sessions exactly
   *   as they behave today.
   * - **First pause wins.** A later reason describes the same stoppage, so
   *   rewriting would churn `since` and lose the original cause. Idempotent by
   *   construction, which lets repair paths call it unconditionally.
   * - **Archived sessions are skipped.** Archiving already removes the session
   *   from every surface, so a latch there would only add unreachable state.
   */
  export async function pause(input: PauseInput): Promise<boolean> {
    const { Session } = await import(".")
    const session = await Session.get(input.sessionID).catch(() => undefined)
    if (!latchable(session)) return false
    // First pause wins: a later reason describes the same stoppage, so
    // rewriting would churn `since` and lose the original cause.
    if (session?.paused) return false

    const paused: PausedInfo = {
      reason: input.reason,
      ...(input.description ? { description: input.description } : {}),
      since: Date.now(),
    }
    let changed = false
    await Session.update(
      input.sessionID,
      (draft) => {
        changed = false
        if (!latchable(draft) || draft.paused) return
        draft.paused = paused
        changed = true
      },
      { preserveActivityAt: true },
    )
    if (!changed) return false
    log.info("session paused", {
      sessionID: input.sessionID,
      reason: paused.reason,
      description: paused.description,
    })
    return true
  }

  /**
   * Clear the latch because the user took the session back: continuing it,
   * abandoning it, or sending new input. Returns whether a latch was present.
   */
  export async function clear(sessionID: string): Promise<boolean> {
    const { Session } = await import(".")
    const session = await Session.get(sessionID).catch(() => undefined)
    if (!session?.paused) return false
    await Session.update(sessionID, (draft) => {
      draft.paused = undefined
    })
    log.info("session pause cleared", { sessionID })
    return true
  }

  /** The latch as stored, or undefined when the session is not paused. */
  export async function snapshot(sessionID: string): Promise<PausedInfo | undefined> {
    const { SessionManager } = await import("./manager")
    const session = await SessionManager.getSession(sessionID).catch(() => undefined)
    return session?.paused
  }

  /** Inspect enrolled recovery candidates; untouched history is prepared on access. */
  export async function listUnfinishedSessions(scopeID?: string): Promise<string[]> {
    const { SessionManager } = await import("./manager")
    const unfinished: string[] = []
    for await (const owner of SessionPauseRecovery.owners(scopeID)) {
      const info = await SessionManager.getSession(owner.sessionID)
      const revision = await SessionPauseRecovery.revision(owner)
      if (await isUnfinished(info)) unfinished.push(owner.sessionID)
      else if (revision) await SessionPauseRecovery.complete(owner, revision)
    }
    return unfinished
  }

  export async function isUnfinished(info: Info | undefined): Promise<boolean> {
    return latchable(info) && !!info && (!!info.paused || (await hasUnfinishedTurn(info.scope.id, info.id)))
  }

  export async function completeRecoveryIfSettled(sessionID: string): Promise<void> {
    const { SessionManager } = await import("./manager")
    const info = await SessionManager.getSession(sessionID)
    if (!info) return
    const owner = { scopeID: info.scope.id, sessionID }
    const revision = await SessionPauseRecovery.revision(owner)
    if (revision && !(await isUnfinished(info)) && !SessionManager.isRunning(sessionID))
      await SessionPauseRecovery.complete(owner, revision)
  }

  async function hasUnfinishedTurn(scopeID: string, sessionID: string): Promise<boolean> {
    const { SessionInbox } = await import("./inbox")
    const { SessionProgress } = await import("./progress")
    if (await SessionInbox.hasRunnableItem(sessionID).catch(() => false)) return true
    return SessionProgress.pendingReplyFor({ scopeID, sessionID })
  }

  /**
   * Whether automatic driving must refuse this session.
   *
   * This is the gate every drive entry consults. It is deliberately narrow: a
   * machine session is never gated even if a latch somehow exists, so reading
   * the same `isUnattended` rule as the writer keeps the two sides consistent.
   */
  export async function blocksDrive(session: Info | undefined): Promise<boolean> {
    if (!session?.paused) return false
    return !SessionInteraction.isUnattended(session.interaction)
  }

  /** Whether the pause latch applies to this session at all. Archived sessions
   *  are already gone from every surface, and a machine session is driven by a
   *  domain that reconciles its own work — a user-facing pause would there be
   *  both invisible and disobeyed. Both writers and readers share this rule, and
   *  a caller deciding whether a stopped turn may stay resumable asks it too:
   *  a stop that cannot pause a session must still settle the turn honestly. */
  export function latchable(session: Info | undefined): boolean {
    if (!session?.time || session.time.archived) return false
    if (SessionInteraction.isUnattended(session.interaction)) return false
    // A Cortex delegation is a machine session in everything but its
    // `interaction` field: the owning domain starts it, reconciles its
    // outcome, and reports progress back to the parent, so no user is
    // watching it. Latching a pause there would leave an invisible session
    // waiting for a continue nobody can give.
    if (session.cortex) return false
    return true
  }
}
