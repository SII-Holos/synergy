# Decision Record: Sidebar draft badge over the persisted per-session prompt state

Status: implemented

## Problem

Unsent composer input is already persisted per session (`session:<id>:prompt` in the workspace localStorage file via `Persist.scoped`), and each session restores its own draft on revisit. But nothing in the sidebar signals which sessions hold unsent input, so users cannot locate drafts without opening each session. The ask: mark sessions with unsent drafts directly on the session row, in red.

The structural constraint: `PromptProvider` mounts inside the session route (`pages/session.tsx`), while the sidebar and mobile drawer live in the app layout above it. Neither navigation surface has access to any prompt context, so the badge needs a source of draft truth that lives outside the provider.

## Decision

The persisted prompt entries remain the single source of stored truth; the badge is served by a derived in-memory index of two mark kinds whose union is what the UI reads.

- `packages/app/src/context/prompt/draft-index.ts` keeps two module-level reactive sets. `storedDrafts` mirrors persisted prompt entries: `rebuildDraftSessionIndex()` scans every `synergy.workspace.*.dat` localStorage file for `session:<id>:prompt` entries and flags those whose sanitized prompt differs from `DEFAULT_PROMPT`. `localDrafts` mirrors the dirty state of composer sessions mounted in this tab. `hasDraftSession` reads their union, so a cross-tab clear event (which only updates `storedDrafts`) cannot erase the fact that the composer the user is typing into still holds unsent input, while a submit in this tab (`markDraftSession(id, false)`) clears both.
- The active session keeps the index live: `createPromptSession` runs a `createEffect` that calls `markDraftSession(id, dirty())`, so marks flip only when dirty flips (not per keystroke), and an `onCleanup` clears the local mark when the LRU cache evicts the session.
- Cross-tab writes come through the `storage` event: a prompt-entry event updates only the `storedDrafts` side for that one session; a `clear()` (key `null`) triggers a full rebuild. The module rebuilds once on load in browser environments.
- Same-tab persistence removals never fire a `storage` event in the document that performed them, so the layout prune path (`dropSessionState` in `context/layout/index.tsx`) calls `forgetDraftSession(session)` after removing a prompt entry, clearing both mark kinds.
- `packages/app/src/components/sidebar/session-draft-badge.tsx` is a pure-props component — `sessionID` plus a pre-localized `label` — so every navigation surface renders it with its own i18n mechanism: the sidebar row (`SidebarSessionRow`, before the title, using `sb-session-draft-badge` with `--text-error`), the mobile drawer Recent list (`MobileDrawerRecent` via a `draftLabel` prop), and the mobile drawer project session list (`SessionRow` via `i18n._(sidebar.draftBadge.id)`).
- `utils/persist.ts` exports `forEachWorkspaceSessionEntry`/`parseWorkspaceSessionEntryKey` because the workspace storage naming scheme belongs to the persistence domain, not to the draft index.

## Alternatives considered

**Persisted draft-index store** (maintain a `Set<sessionID>` in localStorage updated alongside drafts) was rejected as a second source of truth that can drift from the prompt entries, and it would need a backfill for existing stored drafts — scattered one-off migration the repository forbids. Deriving from storage keeps one truth and zero migration.

**Lifting draft state into globalSync/server state** was rejected because it turns a local-UI concern into server state, inflates the change surface by an order of magnitude (API, schema, events), and muddles web/desktop-local semantics: the input box is device-local, so its indicator should be too.

**Badge as an icon-corner dot** (mirroring the completion dot) was superseded by the product decision to use an explicit red bracketed label, which is self-describing and matches how users name the feature ("还有没发出去的消息").

**Clearing the badge directly from cross-tab storage events against a single mark set** (the first shipped cut) was corrected after review: it let one tab's submit erase another tab's badge while that tab's composer was still visibly dirty, and same-tab prune removals never received the event at all. The stored/local union plus the prune wiring are the fix.

## Consequences

- One dirty definition: the badge cannot disagree with the composer's dirty signal because both call the same extracted `isPromptEqual`/`DEFAULT_PROMPT`; a locally dirty composer keeps its badge even when another tab clears the stored entry.
- Rebuild cost is one pass over workspace storage keys with a JSON parse per prompt entry (few KB each); triggers are bounded (load, storage clear, dirty flip) and never on the keystroke path, so the reactive cost is a Set clone per flip.
- Legacy `${dir}/prompt/<id>.v2` keys written before the v2 format are not scanned; those sessions surface their badge only after first visiting them (which migrates the entry). Accepted: legacy drafts are rare and self-healing.
- Layout-pruned sessions have both mark kinds cleared at prune time; a session the user re-opens later re-derives its mark from the re-created persisted entry.
- The storage `storage`-event listener is registered at module scope for the lifetime of the page; it is passive and O(1) per unrelated event (key prefix check).
- Mobile surfaces render the same badge component with Tailwind utility classes (`text-10-medium text-text-error`) instead of the sidebar's CSS file, matching each surface's established styling system.
