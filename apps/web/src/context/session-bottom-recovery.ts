import { createEffect, createMemo, on } from "solid-js"
import { shouldRecoverToLatest } from "@/components/session/session-history-scroll"

export type BottomRecoverySignals = {
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
 * materialize or become recoverable without any user scroll: a history load in
 * flight when the user reached the bottom finishes, or streamed arrivals park
 * into a history window while the user is already parked at the local bottom.
 * A trigger that consumes a single scrolledUp falling edge misses both. This
 * trigger instead evaluates the full recovery predicate as a level and fires
 * once per false-to-true transition, with an in-flight guard so overlapping
 * level flaps cannot stack concurrent recoveries and a settled failure does
 * not retry on its own — only a fresh due transition re-arms it.
 */
export function createBottomRecoveryTrigger(signals: BottomRecoverySignals, recover: () => void | Promise<void>) {
  const due = createMemo(
    () =>
      !signals.scrolledUp() &&
      shouldRecoverToLatest({
        mode: signals.mode(),
        tailMissingLatest: signals.tailMissingLatest(),
        pendingLatest: signals.pendingLatest(),
        historyLoading: signals.historyLoading(),
      }),
  )

  let inFlight = false
  createEffect(
    on(due, (isDue, prev) => {
      if (prev !== false || !isDue || inFlight) return
      inFlight = true
      void Promise.resolve(recover()).finally(() => {
        inFlight = false
      })
    }),
  )
}
