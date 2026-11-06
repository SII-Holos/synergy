# Decision Record: Configurable prompt attachment upload limits

Status: implemented

## Problem

Prompt attachment upload ceilings were hardcoded in the Web composer at 20 files, 25 MiB per file, and 50 MiB total (`apps/web/src/components/prompt-input/files.ts`). Users hitting the per-file ceiling had no supported way to raise it; the values were client-side only, so the server asset route and SDK callers never enforced any limit.

## Decision

Prompt attachment upload limits are now a top-level `attachment` config object in `packages/harness/src/config/schema.ts` (`AttachmentConfig`), registered under the general config domain (`00-general.jsonc`) and materialized with imperative defaults in `packages/harness/src/config/config.ts`:

- `attachment.maxFiles` (int > 0, default 20)
- `attachment.maxFileBytes` (int > 0, default 209715200 = 200 MiB)
- `attachment.maxTotalBytes` (int > 0, default 2147483648 = 2 GiB)

The defaults raise the previous 25 MiB / 50 MiB ceilings to 200 MiB / 2 GiB; the 20-file batch ceiling is unchanged. The values flow to the Web frontend through the existing `GET /config` route (`config.get`, which returns the full merged config); the composer's enforcement helpers in `apps/web/src/components/prompt-input/files.ts` accept a limits parameter and `usePromptAttachments` reads the current Scope config through `useSync` and passes one resolved limits object per selection, falling back to the same defaults. Global-only config cannot represent project overrides. A behavioral hook regression distinguishes global and Scope values, reloads the Scope config, and verifies file count, individual size, total size with existing attachments, and partial-config defaults. SDK types, `packages/sdk/openapi.json`, and `docs/reference/configuration.md` are regenerated artifacts; this record supersedes the size facts stated in [Relax prompt-input attachment format restrictions](2026-08-20-relax-prompt-attachment-formats.md).

## Alternatives considered

**Keep hardcoded values and just document them** was rejected: no escape hatch for large-file workflows, and every residual size constant scattered across client tool code would drift independently.

**Server-side enforcement via a `server.uploadLimits` key scoped to the runtime domain** was rejected for now: the `POST /asset` route and SDK callers have never enforced any size bound, so adding one here would be a new server trust boundary, not a relaxation; client-side config semantics would also be falsely implied.

**Include the Browser file-chooser upload channel (browser page `<input type=file>` handling across `browser-surface.tsx`, Browser protocol, and the desktop host) in the same key** was rejected: that transport has its own duplication in three packages and unrelated failure modes; it stays at its existing 25 MiB / 50 MiB ceilings pending a separate change.

## Consequences

Upload ceilings can now be customized per user or per project via `{ "attachment": { "maxFileBytes": ... } }` in `00-general.jsonc`. Raising the total ceiling to 2 GiB moves the practical constraint to HTTP memory pressure in `packages/server/src/server/asset.ts` (the request body is buffered whole) and to downstream model-context capacity; both are unchanged by this record. The `files.test.ts` assertions derive from the shared default constants, so the test suite tracks default changes without matching them by value.
