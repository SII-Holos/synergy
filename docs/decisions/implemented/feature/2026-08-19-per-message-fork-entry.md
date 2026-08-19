# Decision Record: Per-message fork entry in the assistant output footer

Status: implemented

## Problem

Session forking had a single product entry point: the `session.fork` command (`mod+shift+f` / command palette), which forks the whole effective history at the current head. The backend `Session.fork` already supported `position: { type: "before", messageID }` for point-in-time forks, but no frontend surface exposed it — a user who wanted "start a new session from this reply onward" had no way to express that intent, and the existing command never carried a message position.

## Decision

Two coordinated changes:

1. **Backend: `position.through` fork semantics.** `Session.fork` accepts `position: { type: "through", messageID }`, which copies history through the target message inclusive (the existing `before` stays exclusive). The fork records `forkedFrom.messageID` as the target message, matching the existing lineage contract. The OpenAPI schema and generated SDK (`session.fork` client) are regenerated, so the new discriminator arm is part of the wire contract.

2. **Frontend: fork icon beside Copy Markdown.** The settled assistant output footer (`assistant-message-meta`, previously timestamp + copy button) gains a fork button using the new `action.fork` semantic token (`split` Lucide glyph, registered in the built-in icon registry). The button only renders when a handler is wired (`onForkMessage` prop on `SessionTurn`, threaded through `SessionConversation` from the session page). Clicking it calls `sdk.client.session.fork({ sessionID, position: { type: "through", messageID } })`, shows a success toast, and navigates to the new session. Failures surface an error toast via the standard `requestErrorMessage` path.

New i18n strings: `session-turn.fork-message` (tooltip), `app.session.forked` / `app.session.forked.desc` / `app.session.fork.failed` (toasts), translated in `zh-CN` alongside the extracted `en`/`pseudo` catalogs.

## Alternatives considered

- **Expose the existing `before` position instead of adding `through`** — rejected: `before` excludes the target message, so forking "from this reply" would silently drop the reply the user clicked. A dedicated inclusive arm matches the interaction and keeps `before`'s rewind-style semantics untouched.
- **Place the entry in a message context/overflow menu** — rejected: assistant rows have no existing context menu surface, and the copy-markdown footer is the established quick-action row for settled outputs; a visible icon there is discoverable without new chrome.
- **Extend the `session.fork` command to fork at the active message** — rejected: the command has no message-position input today and changing its semantics would alter the existing `mod+shift+f` behavior; the per-message icon is additive.
- **Reuse the `git-fork` glyph via `workspace.worktree`'s token** — rejected by the semantic-icon contract (one Lucide glyph, one meaning); `split` is registered as a new built-in icon and token instead.

## Consequences

- Users can fork a session at any settled assistant reply directly from the conversation, with the new session opening immediately and lineage (`forkedFrom`) preserved.
- The fork API gains a third `position` arm; existing callers using `current`/`before`/`messageID` are unaffected.
- The UI button only appears where a handler exists, so embedded or plugin-driven `SessionTurn` usages without the prop keep the previous footer.
- The `split` icon addition expands the built-in icon registry and Lucide component map; the semantic-icon contract test enforces the new token's uniqueness and registration.
