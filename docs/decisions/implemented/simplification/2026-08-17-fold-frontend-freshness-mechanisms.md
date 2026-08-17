# Decision Record: Fold frontend freshness mechanisms onto a shared key-space primitive

Status: implemented

## Problem

Three modules in `packages/app/src/context` independently implement the same "keyed map + monotonic counter + prefix-scoped release" machinery, each re-deriving per-scope/per-session generation counters:

- `SyncResourceFreshness` (`sync-resource-freshness.ts:44-193`): `generations Map<string,number>` + `nextGeneration` (:48-49), `revisions Map<string,number>` + `nextRevision` (:50-51), prefix-scoped `clearResources` (:184-192). Guards scope/resource sync responses/events/snapshots with epoch+seq versions.
- `SessionPartSnapshotFreshness` (`session-part-snapshot-freshness.ts:16-87`): `generations` + `nextGeneration` (:17,20), `revisions` + `nextRevision` (:18,21), `snapshotRequiredRevisions` (:19), prefix-scoped `releaseScope`/`releaseSession` (:54-77). Guards message-page apply decisions for a session's message parts.
- `createScopeReconnectRecovery` (`scope-reconnect-recovery.ts:1-33`): `versions Map<string,number>` (:2) and `lifecycles Map<string,object>` (:3) guarding async reconnect completion with lifecycle identity.

The mechanical pipe (allocate a monotonic number, get-or-default, set, delete, delete-by-prefix) is duplicated verbatim in at least four places across the three modules. The semantic layers (epoch/seq comparisons, snapshot-required `>` semantics, async lifecycle identity) guard genuinely different facts and must not be merged.

## Decision

`packages/app/src/context/monotonic-key-space.ts` now ships a `MonotonicKeySpace` class: a `Map<string, number>` with a global monotonic `next` counter and `get` (0 default), `ensure` (lazy create), `allocate` (unconditional fresh number), `set`, `delete`, `deletePrefix`, and `entries` (yields the raw stored pairs).

- `SyncResourceFreshness` (`sync-resource-freshness.ts`): `generations` and `revisions` are `MonotonicKeySpace` instances; `generation()` uses `ensure`, `advanceGeneration()`/`bumpRevision()` use `allocate`, and `clearResources()` calls `deletePrefix` on the revisions space while still clearing `resources` directly. `resources`/`scopes`/`retiredEpochs` and every public method signature and semantic are unchanged.
- `SessionPartSnapshotFreshness` (`session-part-snapshot-freshness.ts`): `generations`, `revisions`, and `snapshotRequiredRevisions` are `MonotonicKeySpace` instances; `capture()` iterates `revisions.entries()`, `touch()` uses `allocate`, and `releaseScope()`/`releaseSession()` use `deletePrefix`. The `action` decision rules are unchanged (revision `===` captured → apply, snapshot-required `>` captured → retry, else preserve; generation mismatch → retry).
- `createScopeReconnectRecovery` (`scope-reconnect-recovery.ts`): `versions` is a `MonotonicKeySpace`; `version()` reads with `get` (0 default), `run()` writes only externally supplied generations via `set` after the strict `generation > current` check, and `release()` uses `delete`. The `lifecycles` identity map and `run()` semantics are unchanged.

No public API, signature, return value, or decision semantic of the three modules changed; no consumers were touched. The primitive imports nothing from outside `packages/app/src/context`.

## Alternatives considered

- **Merge the three modules into one freshness controller** — rejected: they guard different facts (versioned data freshness vs request validity vs async reconnect completion) across different request flows (`sync.tsx`, `global-sync.tsx`, layout prefetch, prompt-input mutations); one controller would force a single key schema and couple unrelated flows.
- **Leave the duplication** — rejected: the counter/prefix plumbing is the drift-prone part (already four copies), and the shared primitive removes it without touching semantics.
- **Fold `scope-reconnect-recovery` into `SyncResourceFreshness`'s generation counter** — rejected: recovery versions are externally supplied and guarded by lifecycle identity for async release-during-flight, which the freshness classes do not model.

## Consequences

- The 27 existing freshness/reconnect tests pass unmodified, plus the `global-sync`, `global-sync-recovery`, `session-volatile-resync`, and `sync-watermark` suites; a focused unit test for the primitive covers paths the class suites do not exercise (`deletePrefix` boundary cases, `ensure` reuse, `allocate` monotonicity, `set` without counter bump).
- The drift-prone counter/prefix plumbing now lives in one place; freshness decisions are unchanged but any future change to the primitive is covered by both the class suites and the primitive's own tests.
- `get` returns 0 for missing keys, `allocate` never reuses a number, and `deletePrefix` matches the raw string key prefix, so callers keep their `"\n"`-separated key contracts.
