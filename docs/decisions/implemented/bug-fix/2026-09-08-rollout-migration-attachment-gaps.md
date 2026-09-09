# Decision Record: Preserve malformed historical attachments as evidence gaps

Status: implemented

## Problem

Startup rollout migration traverses historical message attachments and completed-tool attachments. A malformed inline URL throws during capture and prevents the server from starting. Missing files already produce an audit gap, but invalid URLs do not have a distinct error classification, and an unresolved asset can return without an artifact or a gap. Treating all capture errors as missing content would conceal failures to save evidence.

## Decision

Attachment URL validation emits a dedicated input error. The shared data URL decoder preserves percent-decoded bytes, handles Base64 and non-Base64 payloads, and rejects malformed Base64 instead of fabricating empty content. It follows the byte-processing rules in the [Fetch data URL processor](https://fetch.spec.whatwg.org/#data-url-processor), with provenance recorded beside the authoritative decoder in `packages/harness/src/attachment/index.ts`. The existing MIME-essence return value is retained.

The rollout migration treats this input error, a missing source file, or capture returning no artifact as unrecoverable historical attachment content. It preserves the original attachment and records an explicit gap, then continues processing readable attachments and sessions. Read/write, permission and authoritative recording failures still propagate. Live ingestion retains strict validation. Existing migration identifiers and audit checkpoints remain unchanged.

## Alternatives considered

**Catch every capture failure and continue.** This marks incomplete evidence writes successful and can conceal an unavailable or unwritable store.

**Delete malformed attachments or replace them with empty artifacts.** This loses historical evidence or falsely claims that original content was recovered.

**Only bypass the observed malformed string.** The migration must distinguish input errors from persistence failures across both message and tool attachments, including missing and unresolved asset sources.

## Consequences

One malformed historical attachment does not prevent an upgrade, and the audit still exposes its missing content. Tests cover malformed data and asset URLs, missing assets, valid encoded siblings, live rejection, retry, central migration completion, and a real filesystem obstruction that must remain fatal. Validation of startup upgrades must include nested historical records rather than session metadata alone.
