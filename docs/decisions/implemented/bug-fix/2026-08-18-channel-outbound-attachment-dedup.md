# Decision Record: Deduplicate and filter attachments in channel outbound projection

Status: implemented

## Problem

The Feishu channel outbound bridge projects every attachment from the whole task tree (`projectChannelTaskParts` in `packages/synergy/src/channel/outbound-parts.ts`) onto each terminal reply. Two defects made the same image ride along on every outbound message:

- Deduplication keyed on `attachment.url` fails when identical content exists under different asset urls (a content-addressed asset id and a legacy named id such as `asset://n.png` point at the same bytes), so the same file is uploaded and sent repeatedly.
- `AttachmentDiscovery` (`packages/synergy/src/tool/attachment-discovery.ts`) attaches any image path that merely appears in a bash command's stdout (`detectedFrom: "line" | "path"`). Such incidentally discovered attachments were projected forever, so a stray emoji image found by a `find` probe was attached to every later channel message.

## Decision

`projectChannelTaskParts` now deduplicates by content fingerprint and filters incidentally discovered attachments:

- `attachmentFingerprint(attachment)` returns the content-addressed asset id when the url is a valid hash id (`Asset.isValidId`), because `Asset.generateId` is the sha256 prefix of the file bytes. Non-hash urls fall back to the raw url. The `seen` set is keyed on this fingerprint instead of the url.
- `isIncidentalAttachment(attachment)` skips attachments whose `metadata.attachment.detectedFrom` is `"line"` or `"path"` (bash probe output), keeping only explicit deliverables: the `attach` tool, markdown references, and `file_url` references.

## Alternatives considered

- **Narrow the projection to the terminal task segment** — rejected: the existing contract and tests require projecting tool attachments from earlier assistant steps in the same task; shrinking the range would drop legitimate deliverables.
- **Read file bytes and hash them at projection time** — rejected: hash asset ids already encode content; reading every candidate would add I/O for no gain.
- **Only extend the attachment-discovery skip list** — rejected as insufficient here: it prevents new false positives but does not stop already-materialized attachments from being projected, and the dedup defect is independent.

## Consequences

Identical content is delivered at most once per outbound projection even under different asset urls, and bash-probe artifacts no longer leak into channel messages. Explicit attachments and named (non-hash) asset urls keep their prior behavior. Files that were already persisted as incidental attachments stay in session history but are no longer projected.
