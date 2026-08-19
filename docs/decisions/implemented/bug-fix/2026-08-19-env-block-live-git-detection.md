# Decision Record: env block git detection reads live repo state

Status: implemented

## Problem

The `<env>` system prompt block rendered `Is directory a git repo: no` for the whole lifetime of a session whose scope was created before the directory became a git repository. `SystemPrompt.environment()` derived the line from `scope.vcs`, a snapshot field resolved once when the scope was first created and frozen into the turn envelope for every subsequent turn (`session/agent-turn/worker-pool.ts`). The `<git-health>` block, by contrast, probes the working tree live on every injection. A session that starts in a non-git directory and later runs `git init` (observed in the chatgame "Initialize git repo" session, 20+ turns of contradictory prompting) thus showed a permanent conflict: env said `no`, git-health and every real git command said the directory is a repo. Agents spent tokens every turn rationalizing the contradiction instead of working.

## Decision

`SystemPrompt.environment()` now asks the same live probe that git-health uses:

- `GitHealth.isGitRepo(cwd)` was added to `packages/synergy/src/project/git-health.ts`, wrapping the existing private `resolveRepo()` (which runs `git rev-parse --is-inside-work-tree` with the established 2s timeout and path normalization). It deliberately bypasses the scan cache: the env block needs the current answer, and a cached repo probe would re-create the staleness bug.
- `packages/synergy/src/session/system.ts` computes `isGitRepo` per call via `GitHealth.isGitRepo(ScopeContext.current.directory)` for project scopes, and renders the env line from that. Home scope keeps rendering `no` without a probe.
- The session-scope `vcs` snapshot is no longer the source of truth for this line.

The scope metadata (`scope.vcs`) is intentionally left alone: `Scope.fromDirectory()` already refreshes it on the next re-resolution (covered by `test/scope/scope-stability.test.ts`), so the persisted field heals itself; only the in-flight session snapshot was stale, and this change stops the env block from depending on it.

## Alternatives considered

- **Refresh the scope snapshot / scope.vcs metadata as the fix** — rejected: the per-turn scope is serialized into the worker envelope at turn start, so healing requires re-providing scope mid-loop — invasive to the session lifecycle. The persisted metadata already self-heals; the display was the only casualty.
- **Infer "is a repo" from the presence of a rendered `<git-health>` block** — rejected: git-health renders only when issues exist; a clean repo would render nothing and look like a non-repo.
- **Check `directory/.git` existence with `existsSync`** — rejected: linked worktrees and submodules keep `.git` as a file, not a directory, and the semantics would drift from git-health's `rev-parse` probe — recreating a second source of truth.
- **Delete the env git line** — rejected: the line carries useful information about whether git tooling is available.
- **Add a separate `Vcs.isRepo` implementation** — rejected: a second detection implementation would reintroduce the same two-sources-of-truth conflict this change eliminates.

## Consequences

The env block and git-health can no longer disagree: both answer from the same `rev-parse` probe. Each turn adds at most two short-lived git spawns (one for a non-repo, two parallel for a repo), bounded by the existing 2s timeout and typically under 10ms, comparable to the git-health scan already running per turn. Sessions created before `git init` self-heal on their next turn. The `scope.vcs` snapshot field remains in use by other consumers (diff helpers, branch watcher) and continues to self-heal on scope re-resolution; their staleness was not in scope for this fix.
