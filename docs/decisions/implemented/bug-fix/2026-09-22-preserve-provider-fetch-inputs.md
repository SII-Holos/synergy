# Decision Record: Preserve provider fetch inputs through retries and recording

Status: implemented

## Problem

Provider requests pass through proxy selection, credential recovery, and evidence recording. Converting a fetch input to Request without forwarding its initializer discards native options and body representation. A JSON body with a known length becomes an unknown-length recorded stream, while the provider's native timeout override disappears. Ignoring initializers on existing Request inputs also loses explicit method, header, and body overrides.

## Decision

Proxy selection passes the original input and initializer to the selected fetch function, adding only the configured proxy. The timeout wrapper inherits the Request's headers and caller cancellation before applying its own transport headers and timeout signals; an explicit null signal removes the inherited caller signal. The explicit direct transport constructs its request with both input and initializer. Credential recovery preserves immutable strings and snapshots ArrayBuffer and ArrayBufferView bytes once for every attempt, including sliced views, so caller mutation cannot alter a retry; other bodies use the retry clone's own stream. Transport recording retains its existing materialized-body handling and stream settlement contract.

This follows RFC 9112 section 6.3's preference for a known Content-Length when the request length is available. The authoritative provenance marker is beside body preservation in `provider/auth-recovery.ts`. See [LLM loop and compaction](../../../architecture/llm-loop.md) for the current call pipeline and [the postmortem](../../../postmortem/0024-provider-fetch-wrapper-input-loss.md) for the test gap.

## Alternatives considered

**Buffer every request.** This would hide the distinction by delaying genuinely streamed uploads until their producers finish, potentially deadlocking an interactive producer. Only already-materialized bodies retain the existing buffering path.

**Set Content-Length manually after wrapping.** This would require duplicating body encoding and byte-view offset rules. Preserving the body representation lets the transport derive its length from the bytes it actually sends.

**Change network retries or disable response streaming.** Neither restores lost fetch inputs. Retry policy and SSE consumption keep their existing owners.

## Consequences

Known-length uploads remain compatible with gateways that require their length, and native timeout ownership survives proxy selection. Unknown-length uploads stay streamed and replay through independent retry clones. The existing recording path still copies materialized bytes before dispatch; this change does not add buffering of unknown-length requests or responses. These corrections cannot repair an endpoint that does not complete a TCP handshake.
