# Decision Record: Attachment resource references

Status: implemented

## Problem

Managed images used inline data for model input while other files used Asset references. A provider-file attachment returned by a generation tool could already have an Asset URL, but model projection treated that URL as summary-only. The same bytes consequently had different reference and inference behavior depending on which tool produced them.

## Decision

Managed attachments persist the existing immutable Asset URL regardless of their model policy. Attachment normalization handles both provider-file and summary data URLs through the same store. Model context names that resource URL explicitly so a subsequent answer can reference the same file.

Provider-file projection retains eligible Asset URLs as multimodal input. The Agent turn boundary expands those URLs to bytes only in its transient request, before semantic request recording and worker serialization. Canonical messages remain unchanged. Resolution validates Asset IDs, preserves remote URLs, shares identical reads within the request and propagates missing-file and cancellation failures before provider dispatch.

## Alternatives considered

**Keep inline bytes and add a second presentation URL.** Rejected because parallel resource identities would need reconciliation for every upload, tool result and historical message.

**Treat every Asset URL as summary-only.** Rejected because that silently removes image input from generation and inspection tools whose results already use immutable assets.

**Let the browser or provider read local filesystem paths.** Rejected because neither path establishes the managed Asset ownership or immutable content required for replay and preview.

## Consequences

Model input and presentation share one durable resource identity. Request preparation reads eligible local Assets, and unavailable content becomes a preparation error instead of silently disappearing from inference. The existing URL schema and attachment normalization path accept historical inline data; there is no new asset store or provider protocol. Tests cover immutable history, provider bytes through the real worker and HTTP boundary, invalid references, cancellation and explicit model policies.
