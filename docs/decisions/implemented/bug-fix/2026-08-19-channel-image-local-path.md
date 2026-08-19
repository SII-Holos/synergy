# Decision Record: Persist channel image attachments locally for look_at fallback

Status: implemented

## Problem

Channel (e.g. Feishu) image messages with a pinned model that lacks image input capability degrade the image to a text placeholder at the provider boundary (`ProviderTransform.unsupportedParts`), and the model is directed to use the `look_at` tool with "the file's local path". But the channel attachment seam (`ChannelBusyHandoff.buildDurablePromptParts`) materialized images as data URLs without a `localPath`, so the model-visible context never contained an actual path and `look_at(file_path=...)` had nothing to point at. Chat sessions avoided this because pasted/uploads ran `saveDataPartLocally` (or `asset://` resolution) and attached the real path.

## Decision

`ChannelBusyHandoff.buildDurablePromptParts` now persists a stable local copy of every image attachment via `Attachment.saveDataPartLocally` and sets the resulting path on the part's `localPath`, mirroring chat behavior. The image part keeps its data URL (so the model's file part and provider-file policy are unchanged) and gains a durable `localPath` that survives cleanup of the inbound temp file. Because `MessageV2` already emits `[The user attached a file: ... Local path: ...]` when `includeLocalPath` is set (which it is in the model projection), the model now sees the exact path it needs for `look_at`.

The persistence is best-effort: if saving fails, the part is returned unchanged (data URL only) and the existing degradation text remains, logged at warn level.

## Alternatives considered

- **Persist at materialization time (inbox item → message)** — rejected: the channel temp file is deleted in the handler's `finally` before materialization can run, so the bytes must be copied at the durable-parts seam (before cleanup).
- **Only fix the degradation text** (drop the path promise) — rejected: the look_at fallback is the accepted chat-parity behavior; the gap was that the path was promised but never provided. Persisting the file fixes the root cause.
- **Write to the scope's asset store instead of the media dir** — rejected: chat's data-URL path already uses `Global.Path.media` via `saveDataPartLocally`; reusing it keeps behavior identical and avoids a second storage convention.

## Consequences

Channel image attachments now leave a durable local copy under the data media directory, so the model can analyze them via `look_at` even when the pinned model cannot consume images directly. Cost: one media-directory file per inbound image, matching chat's existing behavior; no retention/cleanup change is introduced (media dir is shared with chat and follows the same lifecycle).
