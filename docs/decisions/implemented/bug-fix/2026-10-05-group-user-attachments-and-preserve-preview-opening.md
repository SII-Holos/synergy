# Decision Record: Group user attachments and preserve preview opening

Status: implemented

## Problem

Part-level conversation rows repeat user timestamps and split attachments from their authored text. New-session preparation renders attachment names before the transcript becomes available. Compact image geometry obscures portrait content and changes after upload. An asynchronous workbench open can fail or return no tab after the resource dispatcher has claimed the click.

## Decision

The shared user content view renders preparation and transcript content from explicit text, attachment descriptors, references, submission time and server origin. The preparation lease allocates future identifiers without inventing canonical Session state and projects captured content through the mounted virtual conversation, as described in [first-send continuity](2026-10-05-first-send-continuity.md). Ordinary user Parts share bounded message groups with one metadata owner; large text and pagination retain independent content leases and stable chunk identities. Source and attachment disclosure belong to the display message identity rather than its mounted row or eventual server identifier. Storage preparation retains this view without admitting unchecked history. Canonical body versions and execution evidence release the captured projection; cancellation and target changes release its owner. Parallel upload completion inserts attachments in their selected identity order.

Draft images use a stable 96×72 cover tile, with 48-pixel automatic editor minimum when attachments are present. Single sent images fit their original proportion within 240×180; mixed groups use 120×96 tiles and measured two-row disclosure. New WebP thumbnails have a longest edge of 512 pixels and carry their dimensions. Undersized or failed thumbnails can use the original image without changing resource identity or original download semantics.

The existing resource dispatcher opens canonical attachments through the workbench, reuses resource tabs and observes panel availability and the asynchronous result. A current target receives failure feedback and retry; obsolete targets receive neither a late panel nor stale feedback. Captured attachments use the shared reader in a dialog until their message is canonically admitted, even though their future identifiers already exist. The dialog uses the captured server origin and closes on cancellation, target changes or provider disposal. Reader failures are local and retryable. Closing the opened attachment restores the originating control when it remains mounted.

## Alternatives considered

- Styling each Part independently leaves repeated metadata, fragmented galleries and preparation rendering unchanged.
- Rendering every user Part in an unbounded row removes large-text virtualization and defeats content budgets.
- Opening all sent images in a separate image dialog bypasses the canonical workbench resource and its reader controls.
- Returning dispatch success without observing the opened tab conceals unavailable registrations and failed asynchronous resolution.

## Consequences

Rendering groups are presentation-only and do not alter HTTP contracts, attachment persistence or model input. Small user messages form complete galleries; larger declared content remains paged and leased. Cropped multi-image previews require the reader to inspect the full image. Original-image upgrades can transfer more bytes for old or undersized thumbnails. Browser composition tests exercise the actual chat button, resource provider, workbench registration and reader, including failure, retry, repeated opening and target invalidation.

User group limits count text body bytes separately from binary attachment payloads: a 128 KiB text budget, six text Parts and 32 total Parts bound each group. Serialized image data must not split a compact gallery while optimistic and canonical summaries coexist. Attachment bodies remain governed by their existing content leases and cache budget. Production frame checks cover a multi-image/document handoff because a single-image fixture cannot reveal a temporary gallery boundary.
