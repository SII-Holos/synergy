# Decision Record: Retry plain provider overload messages

Status: implemented

## Problem

A provider can report "Our servers are currently overloaded. Please try again later." without an HTTP failure status or a structured transient code. Treating this explicit capacity failure as an unknown error terminates the model turn even though the existing retry owners can recover from temporary provider unavailability.

## Decision

The [shared provider classifier](../../../../packages/harness/src/provider/retry.ts) recognizes the distinctive "Our servers are currently overloaded" wording without regard to case. It examines raw messages, parsed error messages and response bodies after cancellation, recording failure, permanent network evidence, terminal provider codes and HTTP refusal statuses have been checked. This classification also corrects a false SDK retry flag when no terminal evidence is present.

The error follows the [existing retry ownership and recovery policy](2026-09-15-network-retry-boundaries.md). SDK normalization, worker serialization, SessionRetry and provider cooldown use the same classification. Ordinary sessions retain their ten additional attempts, jittered exponential delay with a thirty-second ceiling, Retry-After precedence and cancellation. Sessionless callers retain their own attempt and deadline budgets. No retry loop or persisted field is added.

[Provider tests](../../../../packages/harness/test/provider/retry.test.ts) cover representations, terminal precedence, unknown wording and real SDK admission. [Session classification](../../../../packages/harness/test/session/retry.test.ts) covers live, worker-restored and saved unknown errors. [Processor recovery](../../../../packages/harness/test/session/processor-retry.test.ts) verifies three overload failures, exponential delay selection, one successful tool effect and retained failed rollout records. [Provider coordination](../../../../packages/harness/test/provider/retry-coordinator.test.ts) verifies increasing cooldown after an overload probe fails.

## Alternatives considered

**Only classify HTTP statuses and structured codes.** This leaves explicit overload responses without either kind of metadata outside the recovery path.

**Match any overload or retry suggestion.** Generic phrases can describe local failures or permanent refusals; the distinctive provider sentence supplies narrower evidence.

**Add an overload retry loop at the caller.** Separate loops duplicate classification, bypass shared cooldown and risk multiplying existing retry budgets.

## Consequences

Explicit plain overload responses recover through bounded, cancellable backoff while unknown errors and stronger terminal evidence keep their existing behavior. Wording changes require a focused classifier update and regression evidence. Retried generation can still consume provider resources and does not guarantee upstream exactly-once execution.
