# Decision Record: Share one session retry budget across recoverable network failures

Status: implemented

## Problem

A model request can alternate between connection resets and certificate verification failures with no attributable reason. Applying different attempt limits to the same counter makes the final error category determine how much recovery remains. A certificate failure can terminate a request even though ordinary transport failures still have retry capacity. A thirty-second ceiling also keeps later attempts close together during a prolonged disruption.

## Decision

[SessionRetry](../../../../packages/harness/src/session/retry.ts) uses one ten-retry budget for every eligible session failure, including structured certificate verification errors and persisted message-only fallbacks. The original call plus ten additional attempts allows at most eleven model attempts. Error categories retain their diagnostic meaning and recovery messages.

This supersedes the narrower session certificate budget in the [indeterminate network failure decision](../bug-fix/2026-09-19-indeterminate-network-failure-retry.md). That record continues to own classification, diagnostic evidence and caller-specific retry ownership. Sessionless calls and web fetch retain their own limits; certificate verification remains enforced and deterministic certificate failures remain terminal.

The backoff ceiling follows 2, 4, 8, 16, 30, 60 and 120 seconds, then stays at 120 seconds. Jitter, Retry-After precedence, cancellation and tool replay protections remain in force as defined by [LLM recovery](../../../architecture/llm-loop.md#completion-abort-and-errors). Longer later waits give the connection more recovery time while early attempts remain responsive. Regression tests exercise recovery after ten mixed failures, eleven failed attempts on exhaustion, both certificate error representations and the delay bounds.

## Alternatives considered

**Retain the six-retry certificate limit.** This keeps the same unstable connection's recovery window dependent on which error happens last and ends some requests before the common budget is exhausted.

**Keep separate counters for each error category.** Alternating errors would expand the total recovery budget and make its maximum harder to predict. One counter gives the request a clear bound.

**Retain the thirty-second backoff ceiling.** It reaches terminal failure sooner, but repeated attempts during a prolonged disruption leave less time for recovery between calls.

## Consequences

Unclassified certificate failures can use four more retries before termination. Without server retry hints, ten backoff waits total five to ten minutes; requests and shared provider admission can add time. A persistent failure can therefore consume more time and upstream attempts. Shared limits remove category-dependent early termination while retaining a bounded request lifecycle, cancellation and the original failure evidence.
