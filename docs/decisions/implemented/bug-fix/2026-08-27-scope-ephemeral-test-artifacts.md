# Decision Record: Scope Ephemeral Test-Artifact Filter and Archive Migration

Status: implemented

## Problem

Real-home sidebar "Projects" lists accumulate projects the user never created: multiple `synergy` entries (from git worktrees under `~/.synergy/worktrees/*/packages/synergy`) plus a batch of `synergy-test-*` / `synergy-orchestrated-*` test artifacts. Test runs (historically unisolated `--parallel`/`--coverage`, see postmortem `0001-coverage-test-home-pollution`) persisted fixture scopes into the real `~/.synergy/data/projects/*.json`. macOS does not clear `/private/var/folders/.../T/` between runs, and `Scope.list()` only archived records whose worktree no longer exists, so the leaked records stayed visible permanently.

A related display drift existed: `global-sync.tsx` filtered `scope.list()` with a loose `.includes("synergy-test")`, but the sidebar main list (`layout/index.tsx` `list()`) did not filter at all — and the loose filter would wrongly hide real projects under `/Users/eric/projects/synergy-test/<name>`.

## Decision

Make the scope domain the single authoritative filter, archive existing artifacts once via migration, and add a defensive basename-prefix filter on the frontend:

1. **Domain filter** — `packages/synergy/src/scope/test-artifacts.ts` exports `isEphemeralTestWorktreeBasename` (pure basename prefix match for `synergy-test-` / `synergy-orchestrated-`) and `isEphemeralTestWorktree` (basename match + realpath containment under `os.tmpdir()`, tolerant of macOS `/var` vs `/private/var`). `Scope.list()` filters records whose worktree matches, so every backend consumer (scope.list, scope.index / `getAllScopeIDs`, queryGlobal, queryPinned, unread counts, boss, session-search, CLI scrap) stops surfacing them.

2. **Archive migration** — `20260827-scope-archive-ephemeral-test-artifacts` in `scope/migration.ts` enumerates scope records, archives non-archived records whose worktree is ephemeral via `Scope.remove()` (reuses `archiveGuards`, sets `time.archived`). Idempotent; preserves all session/note data on disk.

3. **Frontend defensive filter** — `packages/app/src/utils/ephemeral-test-worktree.ts` mirrors the basename-prefix predicate (browser has no `os.tmpdir()`). `global-sync.tsx` replaces the loose `.includes("synergy-test")`; `layout/index.tsx` `list()` filters both the locally-tracked and supplemented branches so stale localStorage entries never render.

## Alternatives considered

- **Frontend-only filtering** — leaves backend consumers (scope.index, global nav, unread counts) polluted and repeats the display drift that caused the bug. Rejected.
- **Physical deletion of leaked records** — user chose archive (recoverable, keeps session data); `remove()` archive semantics already exist. Rejected.
- **Blocking `Scope.fromDirectory()` writes for test directories** — breaks tests that assert fixture scopes persist (worktree test asserts `Scope.list()`/`fromID`), and does not clean existing records. Rejected.
- **Keeping the loose `.includes("synergy-test")` filter** — falsified by real projects under `~/projects/synergy-test/*`; must be basename-prefix. Rejected.
- **Adding an `ephemeralTest` schema field** — schema/SDK churn for a path-derived signal. Rejected.

## Consequences

- `Scope.list()` hides test artifacts for all consumers immediately; the migration archives existing leaks on next startup without user action.
- Test fixtures no longer collide with the filter: the `tmpdir()` fixture helper creates `synergy-fixture-*` directories, so fixture scopes model real projects and stay visible in `Scope.list()`.
- Real projects are not hidden by the backend filter: tmpdir containment is required in addition to the basename prefix. The frontend mirror is basename-only (browsers cannot resolve `os.tmpdir()`), so a real project literally named `synergy-test-*`/`synergy-orchestrated-*` would still be hidden from the sidebar — accepted tradeoff.
- No schema, OpenAPI, SDK, or config changes; no data deletion.
