# Decision Record: Content-hash media filenames for collision-safe persistence

Status: implemented

## Problem

`Attachment.saveDataPartLocally` persisted media into `Global.Path.media/<date>/` using the attachment's raw `filename` (falling back to a `ulid` name). Two defects:

1. **Same-name overwrite**: two attachments with the same filename but different content (e.g. two messages both named `image.png`) wrote to the same path, silently clobbering the first file. Both chat (pasted images) and the new channel image path (`ChannelBusyHandoff.buildDurablePromptParts`) share this function.
2. **Path escape**: the filename comes from external metadata (e.g. Feishu message filenames, user-controlled), and `path.join(mediaDir, filename)` honored path separators — a filename like `../../evil.png` wrote outside the media directory.

## Decision

`saveDataPartLocally` now derives the persisted name from content plus a 12-hex-char SHA-256 prefix:

- `photo.png` → `photo-<digest12>.png`
- no filename → `<digest12>.png` (replacing the ulid fallback, so identical content without a name is also idempotent)
- the base name is taken via `path.basename(..., extname)` so separators never escape the media directory

Properties: same-named attachments with different bytes get distinct paths (no overwrite); identical content reuses the same path (idempotent, no duplicate files on replay or re-send); the media directory stays contained. The readable filename prefix is preserved for humans, the hash guarantees uniqueness.

## Alternatives considered

- **Random/ulid suffix only** — rejected: fixes the collision but breaks idempotency (same content re-saved twice leaves two files) and still requires separate basename sanitization.
- **Sanitize filename only (no hash)** — rejected: does not fix the overwrite problem at all.
- **Subdirectory per hash** — rejected: unnecessary indirection; a 12-hex prefix collision is negligible (2^48) and the flat date folder already bounds growth.

## Consequences

Persisted media paths are stable per content across chat and channel, idempotent under replay, and cannot escape the media directory via crafted filenames. Existing files written before this change are not migrated; they are simply superseded on next save (no lookup depends on the old naming scheme).
