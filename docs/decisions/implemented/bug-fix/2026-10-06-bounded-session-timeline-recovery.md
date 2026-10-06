# Decision Record: Bound session timeline recovery under storage backpressure

Status: implemented

## Problem

Opening a session could wait for the complete historical display projection before returning the first timeline page. On large histories this saturated the authoritative storage reader, delayed project navigation, and surfaced a generic internal error when storage admission timed out.

## Decision

Session display migration initializes a pending state without scanning historical messages. A timeline request walks the canonical message-order markers newest-first, reads a bounded candidate window, and writes only the summaries needed for that page. Target-message and cursor requests use the same bounded preparation, while explicit display preparation remains the full resumable projection path. History search materializes headers for its matched message IDs before applying visibility rules.

Storage busy and terminal-unavailable errors are translated at the HTTP boundary into a named `StorageServiceError` with state, a bounded retry delay, and `Retry-After`. Timeline loaders recognize that contract, retry transient network failures and storage admission failures with cancellation-aware backoff, and preserve a user-facing recovery message.

## Alternatives considered

**Keep the complete projection in the session-open request.** This preserves a fully warm index before the first page, but makes latency and storage pressure proportional to the entire history and reproduces the failure mode for large sessions.

**Remove the display projection and read canonical messages for every page.** This avoids a migration wait but loses compact summaries, versioned body references, and the existing resumable projection used by explicit maintenance and search.

**Return a generic 500 and rely on manual refresh.** This leaves clients unable to distinguish storage pressure from a permanent route failure and causes synchronized retries without a server hint.

## Consequences

Initial and cursor-based timeline navigation has bounded canonical reads and can render while older summaries are still unprojected. Explicit full preparation remains available for maintenance and exports, and search pays only for headers matching its bounded result page. Storage pressure is observable to clients as a retryable service condition, so foreground requests can back off without hiding unrelated application errors. The first page may not warm the complete display index; callers that need the full projection must continue to use explicit preparation.
