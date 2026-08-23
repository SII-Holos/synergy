# Decision Record: Per-message fork entry in the assistant output footer

Status: implemented

## Problem

Session forking had a single product entry point: the `session.fork` command (`mod+shift+f` / command palette), which forks the whole effective history at the current head. The backend `Session.fork` already supported `position: { type: "before", messageID }` for point-in-time forks, but no frontend surface exposed it — a user who wanted "start a new session from this reply onward" had no way to express that intent, and the existing command never carried a message position.

## Decision

Two coordinated changes:

1. **Backend: `position.through` fork semantics.** `Session.fork` accepts `position: { type: "through", messageID }`, which copies history through the target message inclusive (the existing `before` stays exclusive). The fork records `forkedFrom.messageID` as the target message, matching the existing lineage contract. The OpenAPI schema and generated SDK (`session.fork` client) are regenerated, so the new discriminator arm is part of the wire contract.

2. **Frontend: fork icon beside Copy Markdown.** The settled assistant output footer (`assistant-message-meta`, previously timestamp + copy button) gains a fork button using the new `action.fork` semantic token (`split` Lucide glyph, registered in the built-in icon registry). The button only renders when a handler is wired (`onForkMessage` prop on `SessionTurn`, threaded through `SessionConversation` from the session page). Clicking it opens a compact confirmation dialog (`DialogForkConfirm`, modeled on the rewind-confirm dialog) that shows what will be copied — the user/assistant message counts through the target reply inclusive, a text preview of the reply when available, and the reply time — with Cancel / Fork session actions. Confirming calls `sdk.client.session.fork({ sessionID, position: { type: "through", messageID } })`, shows a success toast, and navigates to the new session. Failures surface an error toast via the standard `requestErrorMessage` path and keep the dialog open for retry.

New i18n strings: `session-turn.fork-message` (tooltip), `session.fork.confirm.*` (dialog copy), `app.session.forked` / `app.session.forked.desc` / `app.session.fork.failed` (toasts), translated in `zh-CN` alongside the extracted `en`/`pseudo` catalogs.

## Alternatives considered

- **Fork immediately on icon click** — rejected: forking is a destructive-ish history split that creates a new session and navigates away; the rewind flow already established a confirmation dialog for history-changing actions, and a one-click fork gives no chance to cancel an accidental tap.
- **Inline confirm popover instead of a dialog** — rejected: the rewind confirm dialog is the established shared pattern for history-affecting confirmations in the session surface; reusing its structure (impact card + Cancel/confirm + pending spinner) keeps visual and interaction consistency.
- **Reuse `DialogRewindConfirm` directly** — rejected: its props, copy, and actions are rewind/retry-specific; a dedicated dialog with fork-specific impact copy is clearer than generalizing the rewind component.

- **Expose the existing `before` position instead of adding `through`** — rejected: `before` excludes the target message, so forking "from this reply" would silently drop the reply the user clicked. A dedicated inclusive arm matches the interaction and keeps `before`'s rewind-style semantics untouched.
- **Place the entry in a message context/overflow menu** — rejected: assistant rows have no existing context menu surface, and the copy-markdown footer is the established quick-action row for settled outputs; a visible icon there is discoverable without new chrome.
- **Extend the `session.fork` command to fork at the active message** — rejected: the command has no message-position input today and changing its semantics would alter the existing `mod+shift+f` behavior; the per-message icon is additive.
- **Reuse the `git-fork` glyph via `workspace.worktree`'s token** — rejected by the semantic-icon contract (one Lucide glyph, one meaning); `split` is registered as a new built-in icon and token instead.

## Consequences

- Users can fork a session at any settled assistant reply directly from the conversation, with a confirmation step before the new session opens; lineage (`forkedFrom`) is preserved.
- The fork API gains a third `position` arm; existing callers using `current`/`before`/`messageID` are unaffected.
- The UI button only appears where a handler exists, so embedded or plugin-driven `SessionTurn` usages without the prop keep the previous footer.
- The `split` icon addition expands the built-in icon registry and Lucide component map; the semantic-icon contract test enforces the new token's uniqueness and registration.
- The confirmation dialog adds a small interaction cost to each fork; the impact card communicates exactly what will be copied so the confirmation is informative rather than a blind gate.

## Review hardening (PR #1226)

- **Stale fork points are rejected.** `Session.fork` validates the requested point against the effective (rollback-projected) history before creating the fork. A point that left the effective history (for example, hidden by a later rewind) now fails with `SessionForkPointMissingError` mapped to HTTP 409, instead of silently forking at the head or producing an orphaned session. The error schema is part of the regenerated OpenAPI/SDK contract.
- **The impact copy never claims precision it lacks.** When the loaded message window does not cover the complete effective history (`hasMore` set), the dialog shows a generic "copy the conversation" summary instead of exact message/reply counts. Exact counts are only shown for a complete window.
- **The dialog cannot be dismissed while the fork is pending.** `dismissible={false}` disables Escape and outside-pointer dismissal during the request; the close button is also disabled and carries an explicit `aria-label`.
- **Count copy uses full ICU sentences.** The summary is a single nested `select`/`plural` message ("Copy 2 messages and 2 replies into a new session.") rather than concatenated fragments, so pluralization and locale word order stay correct in every translation.
- **Dialog behavior is covered by a real-browser DOM test** (Vite fixture + Playwright) asserting rendered copy, aria-label, dismissal guards, and close-on-success; the earlier source-text markup assertions were removed.
- **The dialog is closed on page unmount.** `openForkConfirm` captures the mounted dialog ID and registers an `onCleanup` that closes it when the session page unmounts, mirroring the rewind confirm flow. This prevents forking a stale session from a different page after navigation.
- **The reply-time note is future-tense in every catalog.** The English `copiedNote` ("Will fork from this reply at {time}.") now matches the zh-CN future-tense translation, since the dialog is a pre-action confirmation rather than a post-fork summary.
- **The zh-CN description matches inclusive `through` semantics.** `session.fork.confirm.description` translates to "将此回复及其之前的对话复制到一个新会话中" (inclusive of the target reply), consistent with `position: "through"` and the preview variant.
- **The unused `--fork-border-strong` CSS variable was removed** from the fork dialog stylesheet.
