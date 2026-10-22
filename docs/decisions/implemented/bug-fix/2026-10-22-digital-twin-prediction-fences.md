# Decision Record: Predict for Sessions the user is not viewing

Status: implemented

## Problem

Digital Twin produced nothing for a finished turn while the server had already returned a candidate. Two client-side fences caused it. The request binding included the composer's own revision, and the predict button focuses the editor before dispatching, so clicking moved the binding the click had just built; in-flight requests were aborted or their answers judged stale. Result handling additionally required eligibility, readiness and composer identity to still match, all of which are recomputed on every composer revision and flip while a model request runs. Hydration also replays part summaries for unchanged content, which counted as an edit and moved the source revision for no reason.

Automatic prediction had a second, independent gap: it lived inside the composer. Leaving a Session unmounts that composer, so a turn finishing elsewhere had no observer, and the user found nothing when returning.

## Decision

The binding describes the conversation — connection, Scope, Session, model, configured prediction model and actual source edits — and never the composer's revision. A finished result is accepted when the turn it describes is still the current anchor, regardless of eligibility or readiness churn. Part summaries bump the source revision only when that part's content version moved.

Visibility is separated from eligibility. `eligible` states whether this Session can be predicted at all; `interactive` adds "the user is looking at it" and gates only the button and the completion recheck. A retained view therefore keeps producing a suggestion while the user works elsewhere.

A Scope-level `DigitalTwinBackground` predictor subscribes to root completion, skips Sessions that have a mounted composer, child Sessions, Sessions with a pending draft, disabled automatic prediction and absent capability, and claims one attempt per finished turn through `presence.claimCompletion`. It writes the same versioned per-Session record the composer persists, so the suggestion is present when that composer mounts again. A mounted composer owns its Session, so the two predictors never double-request.

The button names its blocker. A `reason` memo distinguishes view, unfinished turn, draft, pending attachments, composing text, non-normal mode and missing clean reply; the reason is the tooltip label and the accessible description. Failure notices persist until the draft changes or the user dismisses them, instead of expiring on a timer that made the button look inert.

## Alternatives considered

**Keep the composer as the only predictor and let it predict on mount.** A mounted composer has no knowledge of a turn that finished while it was absent, and predicting from a stale anchor would request a suggestion for the wrong turn. Moving the predictor out of the composer is what makes the case reachable at all.

**Accept any result the server returns.** The stamp check against the current anchor is what stops a superseded turn's suggestion from being shown as the answer to the current one; it costs nothing at click time because it does not move with composer churn.

**Keep a timed notice.** A notice that disappears after four seconds is indistinguishable from a button that did nothing, and the user may be reading the reply when it lapses. Persisting it costs one explicit dismiss.

## Consequences

Automatic prediction can now spend a model call for a Session the user is not looking at while that feature is enabled. The alternative was a setting that silently did nothing in the common case. The setting carries only its own label: the digital twin page describes the concept, not the mechanics, and the automatic row does not restate what enabling it does. Manual prediction still works with automatic prediction disabled, and nothing predicts while a Session's composer is mounted.

Suggestions for unviewed Sessions live in the same per-Session browser record as before, so they are bounded by that record's single-suggestion shape and are cleared by the existing accept, dismiss, edit and new-work rules once the user returns. Nothing is retained for a Session whose anchor has since moved.

Coverage is behavioral: the rendered suite drives manual prediction through caret moves, keeps a notice visible across a simulated minute and then dismisses it, and unmounts the composer to prove the Scope-level predictor writes the record and that the remounted composer renders it.
