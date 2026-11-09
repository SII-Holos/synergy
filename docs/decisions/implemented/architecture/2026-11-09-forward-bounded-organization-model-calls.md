# Decision Record: Forward bounded organization model calls

Status: implemented

## Problem

A bound task grant does not limit individual network requests or make a worker safe to receive upstream credentials. Retrying a transport after uncertain transmission can repeat a call, and returning response headers does not prove that its stream or capacity has drained.

## Decision

The organization service admits each model call against a signed machine request, current driver account, project execution role, bound root, resource selection and live connection. Reservation atomically records usage and a receipt without adding a lifetime task quota. The service returns a separately signed, one-call capability containing exact execution identities, resource revision, model and byte/lifetime limits. Duplicate reservation returns the same capability without counting it again.

The model gateway validates that capability, reads a bounded body, checks its model, and rechecks authorization while committing the started receipt. Only then does it resolve server-owned credentials and transmit through a fixed OpenAI-compatible or Anthropic-compatible adapter. Protocol endpoint suffixes and headers are server-controlled. Redirects, browser credentials and caller routing parameters are refused; ambient proxies are disabled and TLS remains verified.

Model SDKs stay outside the service. The gateway forwards JSON and SSE with pull-based response consumption, byte limits, finite lifetime and capacity retained until disposal. Shutdown cancels unread streams and awaits their metadata publication before closing storage. Receipts contain no prompts, response content or credentials. Transport completion does not assert model success or token usage; cancellation and uncertain outcomes remain explicit.

## Alternatives considered

**Give workers upstream credentials or a reusable root token.** Either allows requests beyond the admitted call's resource, revision or limits. A finite call capability preserves the service's authority at every dispatch.

**Retry inside the gateway or replay a retained started call.** A receipt cannot prove whether a remote server performed the request. Deliberate model retries require a fresh call ID under the existing caller-owned retry policy.

**Release capacity when headers arrive.** This permits unbounded held response streams and leaves unread bodies alive through shutdown. Physical body disposal owns release.

## Consequences

Expired or abandoned reservations remain in usage history. Resource changes invalidate outstanding capabilities; new requests require a fresh reservation. Native execution and retry owners retain the task's original budget. Project archival and personal selection-grant revocation preserve accepted root resources, while current driver removal, role loss, binding changes and resource disablement deny new dispatch. Historical actor identity does not replace current driver authorization.

Tests use real SQL, authenticated machine sockets, HTTP servers and the locked model SDKs. They exercise single dispatch, rollback/restart, strict credentials, changed authority, usage beyond former fixed limits, JSON/SSE usage, bounded request/response bytes, redirects, cancellation and unread shutdown. Member provider/worker preparation, native grant release and business connection adapters are separate integrations; member execution remains closed until they are connected.
