import { createEffect, on } from "solid-js"
import { shouldRecoverToLatest } from "@/components/session/session-history-scroll"

export type BottomRecoverySignals = {
  sessionID: () => string | undefined
  scrolledUp: () => boolean
  mode: () => "latest" | "history"
  tailMissingLatest: () => boolean
  pendingLatest: () => boolean
  historyLoading: () => boolean
}

/**
 * Level-based trigger for bounded-window bottom recovery.
 *
 * The gap state (tailMissingLatest / pendingLatestIds) is sync-derived and can
 * become recoverable without any user scroll: a history load in flight when
 * the user reached the bottom finishes, or streamed arrivals park into a
 * history window while the user is already parked at the local bottom. A
 * trigger that consumes a single scrolledUp falling edge misses both.
 *
 * A session always starts disarmed: a retained history window can carry a gap
 * from before the user arrived, and opening that session must not discard the
 * stored view. Engagement — starting a history load, or scrolling up after the
 * session has shown a not-scrolled-up evaluation — arms it; from then on the
 * trigger evaluates the recovery predicate as a level. Arming on scroll-up
 * waits for that observed-bottom evaluation first, so a leftover scrolled-up
 * state carried across an in-app navigation cannot arm the next session
 * through the switch effect's late reset.
 *
 * Firing is latched with hysteresis and frozen while a recovery runs: the
 * recovery's own historyLoading flicker can neither reset the latch nor
 * re-fire it, so a failed attempt never retries on its own — only a fresh due
 * transition (a re-engaged user, a resolved gap, or a session change) re-arms.
 * The in-flight guard spans the whole recovery request, so overlapping level
 * flaps cannot stack concurrent recoveries.
 */
export function createBottomRecoveryTrigger(signals: BottomRecoverySignals, recover: () => void | Promise<void>) {
  let inFlight = false
  let armed = false
  let sawBottom = false
  let settledAfterFire = true
  let lastSessionID: string | undefined

  createEffect(
    on(
      [
        () => signals.sessionID(),
        () => signals.scrolledUp(),
        () => signals.historyLoading(),
        () => signals.mode(),
        () => signals.tailMissingLatest(),
        () => signals.pendingLatest(),
      ],
      ([sessionID, scrolledUp, historyLoading, mode, tailMissingLatest, pendingLatest]) => {
        if (sessionID !== lastSessionID) {
          lastSessionID = sessionID
          armed = false
          sawBottom = false
          settledAfterFire = true
        }
        // A running recovery owns the loading state it observes; freeze arm
        // and latch updates so its own flicker cannot re-arm or re-fire it.
        if (inFlight) return
        if (historyLoading) armed = true
        if (!scrolledUp) sawBottom = true
        if (scrolledUp && sawBottom) armed = true
        const due =
          armed && !scrolledUp && shouldRecoverToLatest({ mode, tailMissingLatest, pendingLatest, historyLoading })
        if (!due) settledAfterFire = true
        if (due && settledAfterFire && !inFlight) {
          settledAfterFire = false
          inFlight = true
          void Promise.resolve(recover()).finally(() => {
            inFlight = false
          })
        }
      },
    ),
  )
}
