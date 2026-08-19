# Decision Record: Seed note editor content on TipTap ready

Status: implemented

## Problem

Opening a note or Blueprint whose list card already showed `previewHtml` could still render an empty TipTap body (only the slash placeholder). Backend storage and `note_read` still had the full ProseMirror document, so the blank editor was a frontend load/layout defect rather than missing content.

Two independent failures stacked:

1. `NoteEditor.applySnapshot()` called `replaceEditorContent()` before `DocumentEditorCore` finished `onMount` and set the editor signal. When no editor instance existed yet, replacement was a no-op, and nothing re-seeded the body after TipTap became ready.
2. The editor shell wrapped title + TipTap + tags in one `overflow-y-auto` column. `DocumentEditorCore` relies on a flex height chain (`flex-1 min-h-0` + inner `h-full`). Nesting that chain inside a scrolling parent collapsed the editor viewport for long documents.

List cards stayed correct because they render server-derived `previewHtml` from note metadata, not the live TipTap instance.

## Decision

Keep list previews on `previewHtml`, and make the open editor resilient to the snapshot/editor race and flex layout:

- Add `isEmptyEditorDoc()` in `packages/app/src/components/note/note-sync.ts` so a blank starter TipTap doc can be distinguished from real content.
- In `NoteEditor`, seed the loaded snapshot from `onEditorReady` via `handleEditorReady` / `seedEditorFromSnapshot`. If TipTap mounts after `applySnapshot`, the ready callback still installs the saved document without marking dirty or emitting an autosave update.
- Split the open-note shell into a non-scrolling flex column: fixed title, `min-h-0 flex-1` editor host, fixed tags. Scrolling stays inside TipTap’s own `h-full overflow-y-auto` surface.
- Cover empty-doc detection and TipTap acceptance of blockId-bearing note JSON with focused App tests.

## Alternatives considered

- **Only pass `content` into `DocumentEditorCore` and rely on first-mount TipTap init.** Rejected: `baseNote` is often applied before the editor mounts, so first-mount still races, and later remote content merges already go through `replaceEditorContent`.
- **Key/remount `DocumentEditorCore` whenever `baseNote().content` arrives.** Rejected: remounting destroys selection, scroll, and in-progress typing for every snapshot merge; it is heavier than a ready-time seed.
- **Treat blank UI as a backend corruption and rebuild content from markdown export.** Rejected: runtime inspection showed full stored content and healthy `previewHtml`; rewriting storage would hide the real owner (frontend load path).

## Consequences

Opening a note now shows the same body the list thumbnail already summarized, including long Blueprints. Autosave still ignores the seed path because ready-time `setContent` uses `emitUpdate: false`. Local dirty content is not overwritten by seed. Maintainers should keep editor scrolling inside TipTap rather than wrapping the whole open-note column in `overflow-y-auto`.
