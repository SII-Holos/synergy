# Decision Record: Title-run recovery and aligned small-model call backoff

Status: implemented

## Problem

A session could lose its auto-generated title permanently, silently. Two independent paths produced the loss:

1. The detached `ensure-title` background job has a 120 s budget. When a provider stalls past it (for example, all traffic flowing through a stalled local proxy), the job's abort signal fires, `AgentCall.text` refuses to retry an aborted call, and nothing re-queues the job — a transient stall cost the session its title forever.
2. `ensureTitle` returned early unless the history contained exactly one prompt-visible user message. A session that already had two or more user messages could never receive an auto title, which made failure mode 1 unrecoverable after the next turn and left every forked multi-message session untitled by construction.

The visible symptom: the session list shows `New session - <timestamp>` indefinitely with no UI signal; the only trace is `failed to generate title` plus `ensure-title outcome=timeout` in the log.

Related: the other small-model call sites (smart-allow permission classifier, agent generator, plugin `agent.call`) carried retry counts at or below one, so a single transient 429/overload — which the shared `SessionRetry` exponential backoff (2 s base, doubling, 30 s cap, jitter, `Retry-After` aware) exists to absorb inside the call's total budget — ended the work immediately even though their timeout budgets had room.

## Decision

The title run is no longer a one-shot event and the small-model call sites align on the shared backoff:

- `ensureTitle` now titles from the **first** prompt-visible user message whenever the title is still the default, regardless of how much history follows it. The call's prompt context is still bounded to messages up to and including that first message, so the generated title keeps describing the conversation's origin rather than its latest turn.
- The retry policy of the title call is raised from 2 to 3, matching the per-message summary title call. The 120 s job budget and the call budget still share one deadline: the provider stall that previously burned the whole budget on attempt one now consumes the deadline across up to four attempts with backoff between them, and a failed run is no longer disqualifying — the next loop turn re-collects `ensure-title` and retries the whole run as long as the title is still the default.
- Smart-allow classifier retries moved from 0 to 1, agent-generator from 1 to 2, and the plugin `agent.call` host service from 1 to 2. Ultimate-failure behavior is unchanged everywhere: title keeps the default title and logs, smart-allow falls through to the ordinary permission prompt, agent-generator reports an error, and the plugin host service maps the error code to the plugin.
- The experience encoder is intentionally untouched: its retry count is already configuration-driven (default 3) and its reencode pipeline layers its own stage retry with backoff.

## Alternatives considered

- **Re-queue the timed-out `ensure-title` job inside LoopJob** — rejected: it adds a requeue mechanism to the job runner for one job type, while the guard relaxation makes the existing per-turn `collect` the natural requeue point; the job only needs to stay cheap to run again.
- **Keep the exactly-one guard and add an explicit "retry pending title" marker** — rejected: marker state would duplicate what `isDefaultTitle` already expresses, and it would not fix forked sessions, which are untitled by construction and must be titleable from a longer history.
- **Title from the latest user message once history is long** — rejected: the title should describe where the conversation started; latest-message titling would produce titles that drift with each turn and differ from what the first-turn run would have produced.
- **Raise the 120 s job budget instead of retrying** — rejected: the incident showed provider timeouts configured three orders of magnitude larger; no finite budget fixes a stall, and a bigger budget only delays the first attempt window before the relaxed guard retries on the next turn anyway.

## Consequences

Sessions whose first title attempt stalls, fails, or races past the job budget recover on a later turn without user action, and forks of multi-message sessions get titles for the first time. The cost is that a long-untitled session's title attempt reads a bounded slice of its history once per turn until it succeeds — the default-title guard keeps that from ever running more than once per session in practice, and the in-flight rename protection (only replace a still-default title) is preserved. The plugin `agent.call` retry increase means a plugin call with a tight `maxRuntimeMs` may spend more of its budget on backoff between attempts; callers that need strict single-attempt semantics keep control through their declared runtime bound.
