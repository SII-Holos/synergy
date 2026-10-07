# Decision Record: Attachment resource references

Status: implemented

## Problem

Managed images used inline data for model input while other files used Asset references. A provider-file attachment returned by a generation tool could already have an Asset URL, but model projection treated that URL as summary-only. The same bytes consequently had different reference and inference behavior depending on which tool produced them.

## Decision

Managed attachments persist the existing immutable Asset URL regardless of their model policy. Attachment normalization handles both provider-file and summary data URLs through the same store. Model context names that resource URL explicitly so a subsequent answer can reference the same file.

Provider-file projection retains eligible Asset URLs as multimodal input. The Agent turn boundary expands those URLs to bytes only in its transient request, before semantic request recording and worker serialization. Canonical messages remain unchanged. Resolution validates Asset IDs, preserves remote URLs, shares identical reads within the request and propagates missing-file and cancellation failures before provider dispatch.

Markdown preserves validated Asset references through both the streaming parser and the settled worker parser. A host-bound resource observer resolves only those references, visits inserted blocks rather than rescanning text on every delta, and opens the shared image preview or attachment reader. The same resolver serves plugin resource opening. Immutable document references can open directly without fetching the originating message; located attachments retain their existing provenance lookup. A reader returns focus by resource identity when terminal Markdown rendering replaced the original link.

Asset ID validation and MIME/extension mapping live in a portable utility consumed by the runtime and UI. Browser URLs are derived from the active server and validated IDs; Markdown does not gain access to arbitrary local paths or executable protocols.

Attachment purpose belongs to the existing presentation contract shared by runtime, plugin tools and UI. Inspection evidence and deliverables retain the same resource identity and independent model policy. New producers declare purpose; omitted purpose means deliverable. A versioned Session migration converts the former metadata boolean and inspection history, preserves immutable bytes and provenance, and invalidates derived display indexes. Import uses the same conversion. Runtime consumers read only the current contract. Part summaries carry visible counts by purpose and tool display classification without embedding attachment data or tool output.

## Alternatives considered

**Keep inline bytes and add a second presentation URL.** Rejected because parallel resource identities would need reconciliation for every upload, tool result and historical message.

**Treat every Asset URL as summary-only.** Rejected because that silently removes image input from generation and inspection tools whose results already use immutable assets.

**Let the browser or provider read local filesystem paths.** Rejected because neither path establishes the managed Asset ownership or immutable content required for replay and preview.

## Consequences

Model input and presentation share one durable resource identity. Request preparation reads eligible local Assets, and unavailable content becomes a preparation error instead of silently disappearing from inference. The existing URL schema and attachment normalization path accept historical inline data; there is no new asset store or provider protocol. Tests cover immutable history, provider bytes through the real worker and HTTP boundary, invalid references, cancellation and explicit model policies. Browser tests cover streamed/settled references, shared previews and readers, immutable downloads, keyboard activation and focus after terminal rendering.

Purpose migration tests cover existing storage, owner isolation, repeated upgrades, imported records, malformed siblings, resource preservation and summary rebuilding. Presentation and outbound delivery no longer depend on undocumented attachment metadata.

The virtual conversation consumes those summaries to separate an invocation's process row from its deliverables at the same chronological position. Hydrated rendering selects the corresponding content without duplicating the tool. Deliverables use the shared gallery directly; evidence uses its compact form within an inspection row. Closing a process retains its output, and image/document inspection contributes inspection facts instead of production counts. Regression tests cover summary-only rows, hydration projection, disclosure, chronology and streaming memoization.
