# Decision Record: Sidebar draft badge over the persisted per-session prompt state

Status: implemented

## Problem

Unsent composer input is already persisted per session (`session:<id>:prompt` in the workspace localStorage file via `Persist.scoped`), and each session restores its own draft on revisit. But nothing in the sidebar signals which sessions hold unsent input, so users cannot locate drafts without opening each session. The ask: mark sessions with unsent drafts directly on the sidebar row, in red.

The structural constraint: `PromptProvider` mounts inside the session route (`pages/session.tsx`), while the sidebar lives in the app layout above it. The sidebar has no access to any prompt context, so the badge needs a source of draft truth that lives outside the provider.

## Decision

The persisted prompt entries themselves are the single source of truth; the badge is served by a derived in-memory index, not by new persisted state.

- `packages/app/src/context/prompt/draft-index.ts` owns a module-level reactive `Set<sessionID>`. `rebuildDraftSessionIndex()` scans every `synergy.workspace.*.dat` localStorage file for `session:<id>:prompt` entries and flags those whose sanitized prompt differs from `DEFAULT_PROMPT` — the same `isPromptEqual` predicate the composer's `dirty()` signal uses, extracted to `context/prompt/equality.ts` so both layers share one dirty definition (context-only additions stay non-dirty, matching composer behavior).
- The active session keeps the index live: `createPromptSession` runs a `createEffect` that calls `markDraftSession(id, dirty())`, so marks flip only when dirty flips (not per keystroke), and dispose the effect when the LRU cache evicts the session.
- Cross-tab writes come free through the `storage` event: a prompt-entry event marks/unmarks that one session; a `clear()` (key `null`) triggers a full rebuild. The module rebuilds once on load in browser environments.
- `packages/app/src/components/sidebar/session-draft-badge.tsx` renders `[Draft]` (localized; zh-CN 「草稿」) as a red (`--text-error`) small-text span before the session title in `SidebarSessionRow`, covering project lists, Recent, and the mobile flyout with one insertion.
- `utils/persist.ts` exports `forEachWorkspaceSessionEntry`/`parseWorkspaceSessionEntryKey` because the workspace storage naming scheme belongs to the persistence domain, not to the draft index.

## Alternatives considered

**Persisted draft-index store** (maintain a `Set<sessionID>` in localStorage updated alongside drafts) was rejected as a second source of truth that can drift from the prompt entries, and it would need a backfill for existing stored drafts — scattered one-off migration the repository forbids. Deriving from storage keeps one truth and zero migration.

**Lifting draft state into globalSync/server state** was rejected because it turns a local-UI concern into server state, inflates the change surface by an order of magnitude (API, schema, events), and muddles web/desktop-local semantics: the input box is device-local, so its indicator should be too.

**Badge as an icon-corner dot** (mirroring the completion dot) was superseded by the product decision to use an explicit red bracketed label, which is self-describing and matches how users name the feature ("还有没发出去的消息").

## Consequences

- One dirty definition: the badge cannot disagree with the composer's dirty signal because both call the same extracted `isPromptEqual`/`DEFAULT_PROMPT`.
- Rebuild cost is one pass over workspace storage keys with a JSON parse per prompt entry (few KB each); triggers are bounded (load, storage clear, dirty flip) and never on the keystroke path, so the reactive cost is a Set clone per flip.
- Legacy `${dir}/prompt/<id>.v2` keys written before the v2 format are not scanned; those sessions surface their badge only after first visiting them (which migrates the entry). Accepted: legacy drafts are rare and self-healing.
- Layout prune deleting persisted prompts can leave a stale mark until the next rebuild; pruned sessions also leave the nav, so the mark is unreachable rather than wrong.
- The storage `storage`-event listener is registered at module scope for the lifetime of the page; it is passive and O(1) per unrelated event (key prefix check).
