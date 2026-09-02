# Decision Record: Stop unrelated navigation from replaying the sidebar project list

Status: implemented

## Problem

Clicking any project or session under the sidebar Projects section made the entire project list visually "jump": every project row faded in and slid as if freshly mounted. Runtime instrumentation showed three compounding causes.

1. **Server event storm.** Every request carrying a `directory` resolved its scope through `Scope.fromDirectory`, which unconditionally rewrote the persisted scope record and broadcast `scope.updated` — even when nothing changed. Each navigation therefore re-emitted the event multiple times.
2. **Frontend index churn.** The layout store listens for `scope.updated` and rebuilds the scope index after a 300 ms debounce. Every rebuild replaced the `scopeIndex` signal with a new array, forcing the Projects list to recompute on unrelated navigation.
3. **FlipList baseline pollution.** `FlipList` snapshots row positions in a render effect. Solid's render effect fires once at mount before the container ref is assigned, so that first pass stored an empty position map. On the next entries change every existing row looked "new", and `FlipList` played the entrance animation (fade + slide) on all of them at once.

## Decision

Each layer stops triggering its downstream churn only when its own input changed.

- `Scope.fromDirectory` (packages/synergy) persists and broadcasts `scope.updated` only when the record actually changed: first creation, or a change in `directory`, `worktree`, `vcs`, or the sandboxes list. Unchanged lookups stay read-only.
- `FlipList` (packages/app) keeps the pre-ref pass from storing an empty position map — the runner returns without touching `previousPositions` while the container ref is unassigned — and seeds the real baseline from `onMount` once the ref and its rows are in the DOM. Later refreshes animate only genuinely new rows and repositioned rows, and the first genuine entries change still animates instead of being absorbed as a silent baseline.
- `loadScopeIndex` (packages/app) compares the freshly fetched index against the current one with a new `sameScopeIndex` helper and skips `setScopeIndex` when the entries are equivalent, preserving the signal identity that downstream memos depend on. Managed Channel projects order within their account by the server's `latestActivityAt`; because the event storm no longer keeps that ordering warm, `session.updated` events for managed project sessions schedule the same debounced index refresh, which the equality guard renders inert when nothing changed.

## Alternatives considered

**Only fix FlipList.** Would stop the visual jump but leave the server rewriting scope records and broadcasting `scope.updated` on every directory-scoped request, and the frontend rebuilding the index after every such event. The wasted work and churn would remain and would keep resurfacing as other reactive noise.

**Skip the event entirely on the server for repeated identical lookups via caching.** A time-based or per-directory cache suppresses broadcasts but adds invalidation semantics around archive/rename paths. Comparing the incoming record against the persisted one gives the same suppression with no new cache state to keep coherent.

**Compare scope indices inside the sidebar instead of the layout store.** Memoizing the Projects list in the sidebar component only guards that one consumer; every other reader of the scope index keeps recomputing. The comparison belongs at the store boundary where the signal identity is owned.

## Consequences

- Repeated directory lookups no longer touch scope storage or emit `scope.updated`; the frontend rebuild path is dormant unless real scope metadata changes.
- The Projects list refreshes only when the server index genuinely differs; unchanged rows keep their DOM nodes and animations no longer replay.
- `sameScopeIndex` is a strict equality over the rendered fields of `ScopeNavEntry`; a server-side field addition that affects rendering must be added to the comparison, mirroring how the sidebar consumes the index.
