# Decision Record: Rename sessions in the Home scope

Status: implemented

## Problem

The session action menu bound Rename to project scopes only (`rename: project` in `sessionActionVisibility`), so Home-scope (global) sessions opened outside a project directory could not be renamed even though Archive, Import, and Export were already available for them. There was no product reason to withhold Rename from Home sessions: the update endpoint supports them, and Pin and Archive already address Home sessions correctly.

Enabling Rename for Home sessions also exposed a latent addressing bug in the rename call path: `DialogSessionRename` and the mobile session-row sent the session's `scope.directory` as the `directory` request parameter. For a Home session that value is the real home directory path (not the reserved `"home"` token), so the server resolved the request through `Scope.fromDirectory(homePath)`, which persists a phantom project scope rooted at the home directory and routes the resulting `session.updated` event to that phantom scope's channel instead of the Home channel — the rename would succeed on disk but the UI would not observe the update.

## Decision

Rename is now available wherever the session action menu is available (`rename: menu`), in both Home and project scopes. Worktree remains project-only, since worktrees only make sense inside a project.

All rename call sites address the session-update API through the same scope contract as Pin and Archive: Home sessions resolve to `{ scopeID: "home" }`, project sessions to `{ directory }`. A shared `sessionScopeRequestFor(session)` helper derives the request from the session payload, `DialogSessionRename` receives a precomputed scope request instead of a raw directory string, and the top-bar and mobile session-row entry points use the helper. Renaming a Home session therefore never registers the home directory as a project scope, and the `session.updated` event is published to the Home channel the frontend is subscribed to.

## Alternatives considered

- **Keeping Rename project-only** — rejected: the original restriction had no product rationale; Archive, Import, Export, and Pin all support Home sessions, and the update endpoint handles them.
- **Mapping the literal `"home"` token through `Scope.fromDirectory` on the server** — rejected: a string that is not a real directory would fall through to the home fallback today, but relying on that implicit behavior would leave the phantom-project hazard in place for any caller that passes the real home path, and it couples server scope resolution to a client token.
- **Switching the dialog to `scopeID` only when the session is a Home session, inline at each call site** — rejected: duplicating the home/project branch in every entry point invites the same drift that caused the original bug; one helper keeps the addressing contract in one place.

## Consequences

- Home-scope sessions can be renamed from both the top-bar action menu and the mobile session-row menu; the UI updates live because the update event reaches the Home channel.
- Rename requests for Home sessions no longer create a phantom project scope rooted at the user's home directory, and no longer emit stray `scope.updated` events.
- Project sessions are unaffected: their rename requests still carry the project directory, exactly as before.
- `packages/app/PRODUCT.md` now documents Rename as available in both scopes with Home addressed via scope ID.
