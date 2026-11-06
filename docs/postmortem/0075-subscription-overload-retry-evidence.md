# Subscription overload lost retry evidence

## Executive summary

A subscription-backed model turn stopped on an overload message instead of entering bounded recovery. The shared classifier lacked the provider's capacity categories, and the locked Responses SDK also omitted failed-response events and nested retry headers. Direct classifier fixtures did not cover the actual adapter's projection. Recovery tests must begin with the provider's wire event and preserve terminal reasons as well as retry hints.

## Summary

Read-only inspection found a completed error message containing the known server-overload text. It was persisted as `UnknownError`, for which retry admission had no matching classification. A manually continued root completed normally. This failure is distinct from a completed reply missing in the frontend: model recovery cannot repair an undiscovered, already-persisted Part.

## Timeline

- Captured the persisted overload error and the later successful turn without refreshing the active application.
- Added failing tests for message-only capacity errors, structured provider codes and permanent refusal precedence.
- Exercised the locked SDK with nested `error` and `response.failed` SSE events; observed lost retry headers and omitted failures.
- Preserved error evidence before projection and verified bounded recovery, stream cancellation and tool-effect isolation.

## Root cause

The retry classifier recognized generic overload types but not the Codex overload and slow-down codes or the two known message-only forms. The adapter's accepted nested error schema removed headers, while its unknown-event fallback discarded `response.failed`. Correct downstream retry policy cannot classify evidence that never reaches it. Testing already-normalized errors missed this path.

## Guardrails

The [real SDK suite](../../packages/local-runtime/test/provider/responses-retry.test.ts) covers wire events, worker serialization, retry hints, stream cancellation, unknown failures and normal output. [Classifier tests](../../packages/harness/test/provider/retry.test.ts) preserve terminal precedence. [Processor tests](../../packages/harness/test/session/processor-retry.test.ts) verify attempt limits, cancellation, failed-output withdrawal and no duplicate tool effects; [AgentCall tests](../../packages/harness/test/agent/call.test.ts) keep one caller-owned budget. The [decision record](../decisions/implemented/bug-fix/2026-10-14-preserve-responses-failure-retry-evidence.md) owns the scope and tradeoffs.

## Lessons

Verify error events through the locked adapter before relying on downstream error handling. Keep subscription usage exhaustion separate from temporary capacity shortages. Preserve structured terminal evidence before accepting an optimistic status or retry hint, and leave retry scheduling with the existing execution owner.
