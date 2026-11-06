# Decision Record: Preserve Responses failures before SDK projection

Status: implemented

## Problem

Subscription capacity failures can reach the session as message-only errors, while the locked Responses adapter omits `response.failed` and strips retry headers from nested error events. Missing classification stops recoverable turns; ignoring a failed response can also allow partial output and pending tool proposals to be treated as successful. HTTP 429 alone cannot distinguish temporary rate limiting from exhausted usage allowances.

## Decision

The shared [provider classifier](../../../../packages/harness/src/provider/retry.ts) recognizes explicit capacity, overload and slow-down codes alongside existing transport failures. Two exact, known message-only forms support errors that already lost their structured fields. Structured terminal reasons, cancellation, permanent transport failures and exhausted SDK budgets take precedence. Usage allowances, billing quotas, policy and input failures do not acquire automatic retry merely because a response includes a retry hint or transient error type.

The [Responses middleware](../../../../packages/harness/src/provider/responses-error.ts) requests the existing raw-chunk output only for the OpenAI Responses adapter. It inspects `error` and `response.failed` before SDK schema projection can omit their meaning, retains code, type, message and recognized retry headers, and fails the stream promptly. It discards raw chunks before they reach the Agent worker event protocol. The compaction parser shares this error extraction. It adds neither another SSE parser nor another retry loop. Authoritative transport recording retains its existing responsibility for raw evidence.

Retry admission and scheduling continue to follow [the shared retry decision](2026-09-15-network-retry-boundaries.md). Ordinary sessions own their bounded attempts, while internal Agent calls own their original caller budget and deadline. Failed proposals remain unexecuted, failed presentation content is withdrawn before another attempt, and post-dispatch failures cannot replay tool effects. The selected model is unchanged.

## Alternatives considered

**Match any message containing “capacity” or “try again”.** This would turn unrelated errors and permanent refusals into repeated requests. Exact fallback messages supplement structured categories without overriding stronger evidence.

**Retry every failed Responses event or HTTP 429.** Usage limits and policy errors require a different action. Unknown failures remain terminal until classification evidence supports recovery.

**Patch the SDK schema or parse SSE again in the fetch wrapper.** The existing raw-chunk facility exposes the necessary event without a dependency fork or duplicate stream framing. A real locked-SDK test protects against future adapter behavior changes.

## Consequences

Temporary overload can recover automatically while preserving the existing attempt budget and cancellation behavior. The Responses path processes one extra internal raw object per SDK event; it forwards no raw object to the UI and retains no stream history. Message-only fallback remains deliberately narrow. Tests cover actual SDK events and worker serialization, retry hints, permanent refusals, resource cancellation, normal output, processor recovery and tool-effect isolation. This policy does not make a saturated upstream service available or resume a task that already ended before the fix was installed.
