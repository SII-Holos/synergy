# Decision Record: Restore sidebar session drag-to-reference and add top-bar copy session ID

Status: implemented

## Problem

Users need to reference another session from the current one. The raw session ID is the durable cross-session address (`session_read` resolves it through the global session index), but there was no way to obtain or copy it, and the desktop sidebar's session rows lost drag-to-input support when the header shell was replaced with a sidebar workspace (`17c92da5d`). The initial release's `session-list-view.tsx` drag source and the prompt input's drop handling predated that rewrite; only the mobile drawer kept drag sources via `SessionRow`/`ActiveZone`.

## Decision

Two complementary app-only paths:

1. **Copy session ID**: the session top-bar overflow menu gains a "Copy session ID" item that copies the current session's raw ID via the shared `copyTextToClipboard` utility and shows a success toast on success. Placement is limited to the top-bar menu per product decision; sidebar and list rows do not get copy affordances.
2. **Restore desktop sidebar drag**: `SidebarSessionRow` becomes draggable and writes the canonical `application/x-synergy-session` payload, so sessions can be dragged into the prompt input and become session-reference chips. Drag payload setup is extracted into a shared `utils/session-drag.ts` helper (`setSessionDragData`) used by the sidebar row.

Home-scope sessions carry the reserved `"home"` directory token in the payload instead of omitting the directory field, because the drop handler and persisted-prompt sanitizer both reject references without a non-empty directory — previously home-scope drags were silently dropped. The sidebar resolves the token via `scopeKeyForNavEntry`, which maps home scope to `HOME_SCOPE_KEY`; `setSessionDragData` only requires a non-empty directory string.

The drop handler's self-reference check is now ID-only (`dropped.id === params.id`): session IDs are globally unique and the old directory conjunction was ineffective for home-scope sessions where `sdk.directory` is undefined.

## Alternatives considered

- **Server-side session-reference part type** (extend `InvokeInput`/`MessageV2`/SDK contracts) — rejected: the server never consumes references; the client inlines a preview at submit time and the `session_read` tool already resolves raw IDs, so a contract change would add generated-SDK and persisted-schema churn with no behavior gain.
- **Copy entry in sidebar/list row hover menus** — rejected by product decision; the top-bar menu is the single copy entry point.
- **Copying the `<session-ref>` marker text instead of the raw ID** — rejected: the raw ID is what `session_read` resolves, and the marker is a client-internal format.
- **Drag support on `MobileDrawerRecent` rows** — rejected: HTML5 drag-and-drop does not trigger on touch surfaces; mobile users get the copy-ID path instead.
- **`createCopyController` for menu feedback** — rejected: the menu closes on click so inline copied-state is invisible; a one-shot copy + success toast matches the interaction (precedent: SynergyLinkPanel).
- **Keeping the `dropped.directory === sdk.directory` self-reference conjunction** — rejected: ineffective for home scope; ID-only check is simpler and correct.
- **Omitting the directory field for home-scope drags** — rejected: drop and sanitize both require a non-empty directory; the "home" token keeps the flow alive.

## Consequences

- Session references work again from the desktop sidebar, and home-scope sessions can be referenced for the first time.
- The drag payload contract (`application/x-synergy-session` with id/directory/title/updatedAt) is unchanged, so existing drop handling, preview inlining, and persisted prompt state are untouched.
- The change is app-only; no server, SDK, or OpenAPI regeneration is involved.
- Copy feedback follows the global clipboard failure hook for failures and a success toast for success.
