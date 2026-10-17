# Retries, cancellation and accounting

For retry changes, exercise raw runtime errors, nested causes, aggregate address failures, worker serialization, SDK admission, and session recovery. Reuse `provider/retry.ts` and the shared network classifier rather than domain-name or broad message matching. Keep one owner for each retry budget; preserve cancellation, permanent failures and recording errors. A model retry must end before tool dispatch can produce effects. Test both successful transient recovery and a post-dispatch failure that must not replay the model; for derived calls, exercise both stream-start and body errors against one caller-owned budget with SDK retries disabled. Verify that retry withdrawal removes failed text and unexecuted proposals from visible history and model context while preserving rollout events, failure status, and accounting. Shared provider recovery belongs before worker admission; test cancellation, bounded waits, one recovery probe, connection isolation, and stale-success/new-failure races.

Exercise streaming error envelopes through the locked provider SDK as well as direct classifier tests. An SDK may omit failed-response events or strip nested error codes and Retry-After hints. Preserve those fields before lossy projection, verify the underlying stream is cancelled, and keep raw provider events outside worker/UI frames. Test message-only subscription overload separately from usage exhaustion, authentication and policy refusals; exact known fallback wording must not override structured terminal evidence.

Classify by evidence strength, never by failure surface alone. The shared classifier's `transient`, `permanent`, `aborted`, and `indeterminate` kinds mean "retry may help", "deterministic failure", "cancelled", and "cause unknown but empirically transient". A mapped reason code (`CERT_HAS_EXPIRED`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `ERR_TLS_CERT_ALTNAME_INVALID`, and similar) is deterministic and stays terminal; certificate verification wording **without** a reason code is `indeterminate` and earns a narrower budget. A runtime drops the reason code exactly when it cannot attribute a verification failure, so `undefined` from the classifier means "unrecognized" and must not silently become "permanent". When adding a certificate or TLS branch, place it after the `permanent` check, keep `aborted > permanent > (indeterminate | transient)` merge precedence, and test both the unmapped wording and every mapped code.

Return the retry budget with the decision rather than relying on a global constant, so a narrower budget is explicit at the call site. Keep the classifier answering only the fact while each caller owns its budget: the session processor, `AgentCall`, and web fetch keep independent limits that must never multiply.

Never relax TLS verification to work around an endpoint failure — no `rejectUnauthorized: false`, no auto-trusting an intercepted CA. When persisting failure evidence, record the endpoint **host only**, derived from the same connection-identity source as `providerRetryKey`. Provider keys are often embedded in the URL path, so reducing a URL to its pathname is not redaction; a regression test must assert no credential path reaches persisted metadata.

## Ownership and accounting

Embedded hosts register ConfigSource for authoritative JSON configuration before sealing composition. Verify invalid snapshots reject startup and host-owned configuration rejects mutation. Keep long tool output with Harness truncation's native artifact storage and retain its failure-propagation tests; follow the [embedded extension decision](../../../../docs/decisions/implemented/architecture/2026-10-05-bound-embedded-host-extension-surface.md).

Report why the operation is sessionless, existing-session, Cortex, or bootstrap; the agent/model role; timeout/retry/tool/output policy; persistence and visibility; redaction; and verification.

Capture provider service-tier metadata when available; unresolved nonstandard pricing must remain unknown. Preserve live authorization evidence before side effects and inherit task snapshots during request preparation, including independent non-chat operations.

Public task cancellation must return after durable cancellation without waiting on held processors. Use explicit Cortex drainage for rollout finalization and runtime shutdown, and test both boundaries with controlled pending calls instead of timing sleeps.

Historical derived retries must not append to a terminal source rollout. Use explicit operation ownership with source identity in metadata, while preserving the caller signal; reserve causal Session ownership for work still owned by the matching root. Test this under an ambient terminal rollout so accidental context inheritance fails.

SDK usage fallback must not assign a call aggregate to each unmeasured transport retry. Test a failed attempt followed by a successful attempt with call usage, and preserve provider-specific cache inclusion and unknown cache-write counts when only SDK evidence remains.

Verify SDK output inclusion against the locked adapter: Google and Vertex expose candidate output separately from thinking, unlike OpenAI. Test reported aggregates, separate components and missing components before labeling fallback totals complete.

When adding model statistics, follow [Usage accounting](../../../../docs/architecture/usage-accounting.md). Capture monotonic model timing at transport arrival before IPC/coalescing/archival acknowledgement; retain wall timestamps separately. Test slow recording, cancellation, retries, hidden reasoning and recovery without fabricating speed. Resolve billing from explicit model/connection/profile metadata and preserve the call-time price snapshot; never infer API billing from authentication or a model name. Verify missing cache fields remain unknown even when input totals are exact.

Record conversation, compaction and auxiliary usage roles at their invocation boundaries, independently of agent names. Test custom conversation agents and queries that include descendants: a child's request or compaction must not replace or invalidate the selected parent's context.
