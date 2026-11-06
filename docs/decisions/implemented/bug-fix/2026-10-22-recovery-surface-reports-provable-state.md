# Decision Record: Recovery surface reports only states it can prove

Status: implemented

## Problem

The conversation recovery surface introduced by [session request recovery](../../implemented/feature/2026-10-21-session-request-recovery.md) renders one shared `ErrorCard` for every `SessionStatus.retry` phase and for any unresolved assistant error. The card therefore appears on states that have neither a deadline nor an action, disappears for a turn that has no other status signal, contradicts the activity header on the same status, and offers a retry action that cannot do what its label promises.

**A card appears for waits with neither a deadline nor an action.** `ProviderRetryCoordinator.acquire` reports `next` only while no probe owns the connection group; when another request owns the probe it reports `next: undefined` and no `retry` (`packages/harness/src/provider/retry-coordinator.ts`, the `onWait` call in `acquire`). `SessionRetry.connecting()` clears `next` and sets `canRetry: false` deliberately. `SessionRecovery` in `packages/ui/src/components/session-recovery.tsx` treats all three phases as visible, so these two states render a card with no description, no progress and no action, under a `state.error` ban glyph from the shared `ErrorCard`.

**The countdown a provider wait shows is not a deadline.** `failure()` computes `entry.until = Math.max(entry.until, now + delay)`, so a second failure on the same connection pushes the deadline later while the card counts down to it. `providerWait()` republishes `startedAt: Date.now()` on every wake, because `onWait` runs once per admission loop iteration. `docs/architecture/llm-loop.md` already states that a wait without a known deadline has no countdown; the card violates that contract, and the existing progress bar can fill and then retreat inside one wait.

**The activity header hides exactly when the card is the only remaining signal.** `showCurrentActivity` in `packages/ui/src/components/session-turn.tsx` excludes `retry` outright, and `hasProcess()` requires turn content that the processor removes before another attempt (`packages/harness/src/session/processor.ts`, part removal for `attempt > 0`). The process row itself always exists for a root (`apps/web/src/components/session/conversation-rows.ts`, trailing process row when no header was emitted), so the empty case is a label decision rather than a missing row: a first attempt that fails before emitting output renders neither header text nor activity text.

**Header and card contradict each other on the same status.** `sessionActivityLabel` in `packages/ui/src/components/session-status.ts` branches on `status.type === "retry"` without reading `phase`. During `connecting` it still prints "waiting to retry · attempt N" while the card prints "reconnecting", and the attempt number belongs to local backoff that already elapsed. During `waiting_provider` it prints the same label for a request that has not been sent yet.

**The terminal retry action repeats an exhausted attempt.** Automatic retry admits the same class of error the button offers: `SessionRetry.retryable` requires a retryable `APIError` with a ten-attempt budget, and the card's action requires `APIError` with `data.isRetryable` after that budget is spent. The button is therefore the eleventh attempt at something that just failed ten times, delivered as a hidden steering message through the Inbox. Users already restart a terminal turn by sending a message: `submitInput` treats human input as a new task root when the pause reason is `failed` (`packages/local-runtime/src/session-api.ts`), so the deliberate path exists and is narrower than retry in one respect — retry passes through `SessionExecutionOwners.assertResume`, which rejects a saved task whose dependency is unavailable while a new message does not.

**The admission timeout is a dead end.** `acquire` throws a bare `Error` named `ProviderRecoveryTimeoutError` after the five-minute admission limit. `MessageV2.fromError` reaches its `e instanceof Error` case and returns `NamedError.Unknown`. No consumer of that name exists: the only occurrences are the throw and one coordinator assertion, and `git log -S ProviderRecoveryTimeoutError` shows it was introduced with the coordinator and never mapped. `SessionRetry.retryable` does not match it, so the turn terminates; `SessionRecovery.action()` has no branch for it, so the card shows raw details with no action.

The surface needs one rule it can honour: show a card when there is a countdown we own, or a terminal failure that needs evidence. Everything else belongs to the activity header, which is built to carry fine-grained status.

## Decision

**1. Card visibility becomes a predicate over phase and run ownership.**

`SessionRecovery` keeps a card only when the retry state belongs to this root and its phase is `waiting`, or when an assistant error is unresolved and no run is active for this turn. Terminal errors stay readable while a newer turn runs; a `busy` or `retry` status for the same turn suppresses them, because the retry itself is the acknowledgement. The `ui.recovery.connecting`, `ui.recovery.waitingResponse` and `ui.recovery.provider` branches and their copy are removed, and the extractor drops the unused ids.

**2. The activity header becomes phase-aware.**

`sessionActivityLabel` gains the retry phases: `waiting` keeps "waiting to retry · attempt N", `waiting_provider` reports provider-connection recovery through a new `session.activity.retryProvider` descriptor, and `connecting` reuses the existing `session.activity.waitingModel` copy. Transport disconnection, approval and question keep their current priority. No phase prints a deadline it cannot keep.

**3. The activity header renders for retry without turn content.**

`showCurrentActivity` treats `retry` as a current-activity state instead of excluding it, so a turn whose attempt failed before producing output still renders the header label. Motion stays off, because `sessionActivityAnimating` returns false for `retry` and that must not change: a scheduled wait has nothing to animate.

**4. A terminal card carries evidence and configuration repair only.**

The `APIError`-with-`isRetryable` branch is removed from the card's action, so an exhausted retry budget offers no action and the user restarts by sending a message. `ProviderAuthError` and the 401 branch keep `Reconnect`; `ProviderModelUnavailableError` and `ProviderModelVariantUnavailableError` keep `Choose model`. These two survive because sending another message reproduces the same failure, so no other path exists. The admission timeout keeps no action either: it is terminal, and a named-error branch for it would be the kind of one-off exception this rule exists to prevent. `ui.recovery.retry` becomes unused once the button only ever appears over a live wait, and is removed.

**5. No surface publishes a provider wait as a deadline.**

`waiting_provider` keeps publishing the original error and the waiter identity for tooltips and diagnostics, but `next`, `startedAt` and `attempt` stay inert for that phase; no surface reads them as a deadline or a stable start. The status bar stops painting `danger` for the two phases that are not failures: `waiting` keeps its danger tone and pulse, while `waiting_provider` and `connecting` keep the pulse and use the ordinary working tone. Without that change the ban-toned status bar becomes the loudest remaining signal on a healthy in-flight request.

**6. Documentation, copy and verification move with the change.**

`docs/architecture/llm-loop.md`, `docs/architecture/frontend-data-sync.md` and the frontend conversation reference in `develop-frontend` describe the header as the fine-grained surface and the card as countdown-or-terminal. `docs/decisions/implemented/feature/2026-10-21-session-request-recovery.md` gains a supersession pointer to this record. Catalogues are regenerated with `i18n:extract`, translated, and gated by `i18n:check`. Tests cover each phase at the card, the label at each phase, the retry-without-content predicate, and the coordinator's early return.

## Alternatives considered

**Split `waiting_provider` into deadline and probe-held variants and keep a card for both.** Rejected because the variants alternate inside one wait: a probe release turns the deadline into an event wait and back, so the card would appear and disappear repeatedly in a single pause. It also keeps a ban glyph and an error frame on a state whose only content is "still queued".

**Keep a card for `waiting_provider` with an "earliest retry" countdown.** Rejected because the number is a lower bound that any concurrent failure can push back, which is the same defect in softer wording. Honest copy would read "at least N seconds", and the card would still offer an expedite action that cannot progress while another request owns the probe.

**Hide the card for `connecting` but keep it for `waiting_provider`.** Rejected as an inconsistent middle: neither phase has an action, and neither has a deadline the user can trust, so the rule would be remembered by phase name rather than by what the surface can prove.

**Keep the terminal retry action for retryable errors.** Rejected because it is the eleventh attempt at the same request, and the restart path that users already have — sending a message — is strictly more capable in the one case where retry would fail. Keeping both invites the two paths to diverge.

**Add a named `ProviderRecoveryTimeoutError` branch to give the admission timeout a retry action.** Rejected because it is terminal like every other exhausted failure, and a dedicated branch for one error would reopen exactly the pattern this rule closes. `NamedError.Unknown` already carries a readable message, since `fromError` uses `e.toString()` for an `Error` instance and the coordinator sets a descriptive `name`.

**Remove the terminal delivery branch of `session.retryRequest`.** Deferred rather than rejected: this UI stops reaching it, but it remains the only programmatic way to restart a terminal turn for other SDK clients, and retiring public API behavior belongs to its own decision rather than to a presentation change.

## Consequences

Each surface now states only what its own evidence supports. A `retry` status in `waiting_provider` or `connecting` renders no error card while the activity header names that phase; a retry whose turn produced no content still renders the header label; `waiting` renders one card whose description counts down to the published deadline and whose "Retry now" action wakes the wait while `canRetry` is true; a terminal retryable failure renders evidence with no action, while authentication offers `Reconnect` and an unavailable model offers `Choose model`; the status bar no longer paints `danger` for the two waits that own nothing. `bun run decision:check`, `bun run --cwd apps/web i18n:check`, `lint`, both package typechecks and the focused suites for `packages/ui` and `apps/web` establish that.

**The countdown card disappears once local backoff ends.** It previously persisted through `connecting`; with the new predicate it vanishes the moment the request goes out, so the visible acknowledgement of an in-flight retry becomes the header alone, and the footer changes height at that boundary. This is the intended trade: the card stops claiming to know when output will arrive.

**A terminal retryable failure no longer offers a one-click restart.** The user must send a message, which re-authors the prompt. That is the cost of having one restart path instead of two, and it is the path that works when a session dependency is unavailable.

**The expedite affordance for provider waits is lost.** A user can no longer push a queued request past its shared cooldown. The action was already unavailable whenever another request owned the probe, and it never bypassed a server `Retry-After`; the remaining cost is that the one case where it worked now requires waiting out the cooldown.

**Suppressing the terminal card during an active retry trades evidence for acknowledgement.** If a manual wake hangs, the user sees the header rather than the original failure. The failure returns with its details as soon as the retry settles, and an older turn keeps its evidence visible while a newer turn runs.

**Inert retry fields invite future misuse.** `attempt` and the refreshed `startedAt` remain in provider-wait payloads. A later surface could read them as a deadline or a stable start, which would reintroduce the defect this record removes.
