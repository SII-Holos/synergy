# Decision Record: Classify attachment deliverability at creation for channel outbound projection

Status: implemented

## Problem

The Feishu channel outbound bridge projects the completed tool attachments of a task tree (`projectChannelTaskParts` in `packages/synergy/src/channel/outbound-parts.ts`) onto every terminal reply. `AttachmentDiscovery` (`packages/synergy/src/tool/attachment-discovery.ts`) attaches any supported file path that merely appears in a bash command's stdout (`detectedFrom: "line" | "path"`) as a first-class attachment, indistinguishable from explicit deliverables. In boss-session flows a debug probe once matched a Flutter pub-cache test image; that incidental attachment was then re-projected onto every later channel message.

## Decision

Attachment deliverability is classified **once, at creation**, and consumers only read the verdict:

- `AttachmentDiscovery.discover` writes `metadata.attachment.deliverable` on every attachment it creates: `true` for explicit references (`detectedFrom: "markdown" | "file_url"`), `false` for paths that merely appeared in tool output (`"line" | "path"`).
- The `attach` tool writes `deliverable: true` on its attachments.
- `MessageV2.isDeliverableAttachment(attachment)` is the single predicate: it prefers the canonical `deliverable` verdict and falls back to the legacy `detectedFrom` heuristic for attachments persisted before the verdict existed, so already-materialized incidental attachments also stop being projected.
- `projectChannelTaskParts` skips non-deliverables via that predicate and keeps deduplicating by asset url within the projection. Deduplication by content fingerprint was considered and rejected: content-addressed asset ids already encode the bytes, so identical content stored under two resolvable urls cannot occur in the current codebase, and legacy named ids (`asset://n.png`) are rejected earlier by `resolveAttachmentSource` — the fingerprint key was unreachable and its test passed on the old code.
- Delivery deduplication is **root-scoped**, not terminal-scoped: after a successful channel send, the attachment urls actually delivered are recorded on the task's root user message (`metadata.channelOutboundAttachmentUrls` via `markChannelTaskAttachmentsDelivered`). Re-projecting the same task tree later (steer wake-ups, boss reports, agenda continuations create a new terminal in the same root) skips urls already recorded. A new task is a new root, so the record starts empty and a file can be deliberately re-delivered in a later task. The previous terminal-scoped `channelOutboundSent` marker alone could not prevent this: it only gates the bridge trigger for one terminal message, while the projection walks the whole root tree.

## Alternatives considered

- **Narrow the projection to the terminal task segment** — rejected: the existing contract and tests require projecting tool attachments from earlier assistant steps in the same task; shrinking the range would drop legitimate deliverables.
- **Deduplicate by content fingerprint (hash asset id) instead of url** — rejected: unreachable in the current codebase. `Asset.isValidId` only accepts 16-hex ids; the legacy alias url (`asset://n.png`) is discarded by `resolveAttachmentSource` before projection, and two _resolvable_ urls for the same bytes cannot exist because `Asset.generateId` is a content hash. Uniqueness is already guaranteed by url dedup, per-task root scoping, and the `channelOutboundSent` marker.
- **Filter by re-deriving `detectedFrom` heuristics in the projection layer** — rejected: it duplicates discovery's classification vocabulary in a downstream consumer, so a future source of incidental attachments would need the filter copied again, and it leaves the model context and UI consuming the same incidental attachments.

## Consequences

- Explicit deliverables (attach tool, markdown references, file urls) are projected exactly as before. Incidental tool-output artifacts are no longer projected to channels — including ones already persisted before this change, via the legacy fallback. The classification lives in the attachment metadata schema at the point of creation, so every consumer (channel projection today, model context or UI later) reads one verdict instead of re-deriving heuristics. A task tree whose attachments were already delivered does not re-send them when the same root is woken again by a later system/steer/agenda message; failed sends record nothing, so the next attempt still re-delivers.
