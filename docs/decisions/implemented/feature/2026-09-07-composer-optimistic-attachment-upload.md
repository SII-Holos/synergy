# Decision Record: Composer attachment uploads show optimistic pending cards

Status: implemented

## Problem

Attaching a file to the composer showed no feedback until the upload finished. `usePromptAttachments.addAttachment` awaited `uploadPromptAttachment` before inserting the attachment part into the prompt, so a large file left the input box silent for seconds and the card appeared all at once. Users could also send mid-upload, silently producing a message whose attachment they believed was attached.

## Decision

Composer attachment selection is optimistic. Choosing, pasting, or dropping files immediately renders a pending attachment card in the composer (filename, size, spinner) backed by a session-local `PendingAttachmentTracker` — deliberately outside the persisted prompt draft, so a reload mid-upload drops the card rather than persisting an unusable placeholder. `runPendingAttachmentUpload` uploads in the background, then inserts the settled part under the same pending id and briefly flashes an "Uploaded" state before the normal attachment card takes over (`apps/web/src/components/prompt-input/attachment-upload-flow.ts`, `pending-attachments.ts`, `pending-attachment-card.tsx`).

Sending is gated while uploads are in flight: `shouldBlockSubmitForUploadingAttachments` disables the Send control and the tooltip/aria-label explains why, `usePromptSubmit` repeats the guard for Enter-key submits so keyboard paths cannot bypass the disabled button, and toast feedback mirrors the existing submit guards. Stopping a running session stays available because it sends nothing. Removing a pending card cancels its upload (the settled result is discarded); removing a flashing "Uploaded" card also removes the inserted part. A destination (session) change mid-flight drops the result instead of inserting it into the new session. Batch limits count in-flight entries via the tracker's scope.

Multi-file selection uploads in parallel (`Promise.allSettled`); each failure keeps its own error toast.

## Alternatives considered

**A `status` field on the persisted attachment part with a placeholder URL.** Rejected because the prompt draft is persisted and sanitized; a transient status would either leak into the draft schema (requiring migration and sanitization changes) or produce ghost draft entries after reload. Local tracker state keeps the persisted shape untouched.

**Blob-URL local image preview during upload.** Deferred: it improves image UX but adds object-URL lifecycle management, preview swapping, and a second URL source to sanitize; the placeholder card already fixes the core feedback gap.

**Queueing uploads serially.** Rejected: files were previously uploaded sequentially for no product reason, which multiplied the wait for multi-file batches; parallel uploads with per-file failure isolation are strictly better.

**Toast-only feedback ("Uploading file…").** Rejected: a transient toast does not occupy the attachment slot, cannot be removed/cancelled by the user, and gives the composer no stable state to gate sending on.

**Real per-byte upload progress (XHR `upload.onprogress`).** Implemented then rolled back: the fetch-based generated SDK client cannot report upload progress, and the XHR transport that could (`apps/web` no longer contains it) did not produce visible progress in the deployed environment. The indeterminate spinner is kept until a progress signal is verifiably reliable.

## Consequences

Cost: a second source of attachment truth (tracker + prompt parts) with explicit hand-over rules (same id, flash window, cancel semantics); `removeAttachment` must consider both stores; the DOM behavior test and the flow unit tests pin these invariants.

Bought: immediate visible feedback for large uploads, a hard guarantee that a sent message contains every attachment the user saw, cancel-before-send, mid-flight session switches that cannot strand attachments in the wrong draft, and no persisted-state or API contract changes.

Clearing or disposing the destination invalidates every in-flight upload even if navigation later returns to the same session. Settlement releases cancellation markers and does not show errors for uploads the user already discarded. Pending-card removal remains visible on touch layouts and keyboard focus.
