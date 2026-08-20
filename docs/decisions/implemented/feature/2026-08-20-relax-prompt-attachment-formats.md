# Decision Record: Relax prompt-input attachment format restrictions

Status: implemented

## Problem

The prompt input gate kept a strict extension/MIME whitelist: images (png/jpeg/gif/webp), Office/PDF documents, and ~44 text/code extensions were accepted; zip/mp4/mp3/exe and arbitrary binaries were rejected with a toast. The backend pipeline already handled arbitrary files (`Attachment.policy` routes images to `provider-file`, extracts pdf/documents, and carries everything else as summary-mode attachments with a durable local path), and `Document` extraction even supports epub/ipynb/zip/wav/mp3 formats the frontend refused to upload. The pipeline was wider than the gate, so users could not attach files (data exports, archives, build artifacts, binaries) that the agent could legitimately inspect through its file tools (read/bash/file) using the projected local path.

## Decision

- Frontend (`packages/app/src/components/prompt-input/files.ts`): the type whitelist is removed; `FILE_INPUT_ACCEPT` is `*/*` and any file type is attachable. Only size/batch ceilings remain: 20 files, 25 MB per file, 50 MB total (aligned with Browser upload limits). Toast copy now reports oversized files instead of unsupported types.
- Backend (`packages/synergy/src/attachment/index.ts`): the `other` policy now sets `saveLocal: true`, so arbitrary binary attachments (including data: URL sources) are materialized to durable Asset paths the model projection can expose.
- Model projection (`packages/synergy/src/session/message-v2.ts`): summary-mode user attachments that are neither text nor image append `. Attached as-is; use file tools to inspect` to the projected text, steering the agent to inspect the file through tools rather than assuming direct readability.
- Attachment execution boundaries are unchanged: autonomous worktree policy still denies executing attachments through interpreters (PR #1119 semantics); this change only broadens uploads and read-only inspection.

## Alternatives considered

- **Allow only formats the backend can extract** (epub/ipynb/zip/audio): too narrow; it still blocks legitimate data files, archives, and binaries, and "what the model can read" is a backend policy decision, not a frontend extension list.
- **Keep an executable/installer DENY list**: autonomous execution is already denied, so the list adds maintenance without a real boundary gain; the user chose full relaxation.
- **Status quo**: keeps the toolchain (read/bash/file on attachment paths) effectively unused for the most common real-world files.

## Consequences

- Any file can be attached; direct-read formats (images, documents, text/code) keep their exact prior behavior and token cost.
- Binary attachments now occupy durable Asset storage; the 25 MB / 50 MB / 20-file ceilings bound that cost, and oversized uploads are rejected with clear copy.
- Model context grows by at most one summary line plus local path plus tool hint per attachment — no binary content is inlined.
- Frontend tests (`files.test.ts`) flipped from asserting zip/mp4/exe rejection to asserting acceptance and size limits; backend policy tests assert `other` persists locally; message-v2 projection tests cover the tool hint.
