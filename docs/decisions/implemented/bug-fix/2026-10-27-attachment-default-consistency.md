# Decision Record: Persist attachment defaults before publishing history

Status: implemented

## Problem

An omitted attachment presentation purpose has a defined default, but the write path retained the omission while record access materialized it. Cached and reloaded histories could therefore differ without any edit. Compaction's source check rejected a completed summary when an earlier task's attachment entered the covered interval. See the [incident analysis](../../../postmortem/0094-compaction-attachment-default-drift.md).

## Decision

`Session.preparePart()` fills omitted purposes through the shared `attachmentPurpose()` contract for standalone and completed-tool attachments. Storage, cache publication, returned parts and events consume the prepared record. Explicit purpose, other presentation options, source ownership, model policy and media evidence remain intact; preparation does not mutate the caller's attachment.

Historical records and imports retain the existing attachment presentation migration, including its legacy inspection-tool classification. Transcript import applies the central record upgrader before preparing parts, so current defaults cannot replace historical classification. Current write defaults do not change that migration or require another historical rewrite. Migration fixtures explicitly store the historical omitted field after preparing their binary evidence.

Compaction retains its transactional source comparison. The regression uses real storage and a warm history cache, an attachment from an earlier task, and a deterministic summary response; a successful summary commits without changing its source. Separate cases preserve rejection of changed text, source cursors and inserted messages.

## Alternatives considered

**Ignore attachment presentation during compaction comparison.** This would hide the inconsistent history representations while leaving other cache consumers exposed.

**Reload or retry every compaction.** This would add history reads or model calls without correcting the writer that produced the mismatch.

**Run historical migration heuristics on each new write.** Current callers use the explicit presentation contract; legacy tool-name and delivery-metadata inference remains with the historical upgrader.

## Consequences

New records explicitly store a previously implicit value. No API field, migration version or model request policy changes. Tests cover warm/cold history parity, cache eviction, standalone and nested attachment defaults, explicit evidence, input immutability, retained bytes, historical conversion, transcript import and compaction commit safety. The canonical attachment contract lives in [Sessions and messages](../../../architecture/session-and-messages.md#assets-and-attachments).
