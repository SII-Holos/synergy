# Decision Record: Bound managed worktrees with a cap-based janitor

Status: implemented

## Problem

Managed git worktrees accumulated without limit. The machine that motivated this work held 19 managed worktrees and 32 GB, of which 24 GB was `node_modules` with no hardlink sharing between checkouts, growing at roughly four worktrees per day. Nothing in the runtime was ever going to stop that.

The reclamation code existed but could not run. `Worktree.collectGarbage` and `pruneStaleRegistry` had **zero call sites** anywhere in the repository, and `git worktree prune` was never invoked at all. The only partial reclamation was Cortex-specific, and its dirty branch marked a worktree `gc_candidate` and returned, deferring the decision to that dead code — which made `cleanupState`'s `gc_candidate → safe_to_remove` transition unreachable.

What remained was also wrong in ways that only mattered once it ran:

- `collectGarbage` called `unlockStale`, which unconditionally unlocked **any** stale worktree. That clears a lock a user set deliberately.
- It removed with plain `git worktree remove`, which cannot succeed on a locked tree, so a locked worktree was retried forever.
- It only considered `item.stale`, so the ordinary case — a live, idle, unused worktree — was never a candidate.
- It had no branch step, so merged `synergy/*` branches stayed behind; 18 had accumulated.
- It called `list()`, which computes directory size for every worktree via `directorySize`. Measured at 29 GB, that is not affordable on a background tick.

Two smaller defects sat in the same area. `Worktree.remove` never deleted a branch, and `git-health` advised `git branch -d`, which is guaranteed to fail after a squash merge: the tree can be byte-identical and git still reports the branch as not fully merged. The same component reported `gc_needed` as `critical` at 200 loose objects when git's own effective threshold (`gc.auto`) defaults to 6700 — a false alarm firing on a repository holding 297 loose objects, 4.3% of the real limit.

The published architecture invariant said cleanup "removes resources only when their recorded owner permits it; a worktree is not inferred to be disposable merely because one session stopped using it." A cap-based janitor removes worktrees precisely because they are idle, so the invariant and the requirement could not both stand unchanged.

## Decision

Managed worktrees are bounded by a count cap that only ever reclaims worktrees proven safe to lose, and every refusal is reported rather than swallowed.

`sweep()` replaces `collectGarbage`, `pruneStaleRegistry`, and the old `cleanupState`. It reads a lightweight `inventory()` — `git worktree list --porcelain` plus the registry, with no directory sizing — so a background tick never walks the checkout. Each managed worktree is judged by the pure function `decide(info, evidence)`, which returns either eligible or a specific keep reason, in this order: not managed (`external`), main (`main`), locked by anyone other than Synergy (`foreign_lock`), bound to a running session (`running`), dirty (`dirty`), dirty-but-unprobed (`unknown_dirty`), or holding local-only commits (`local_only_commits`).

Four properties follow, and each is load-bearing:

**A foreign lock is never cleared.** The `synergy:v1:` reason marker is the only proof of ownership. `releaseLockForRemoval` returns false — and `removeWorktree` refuses — for an unmarked lock, an empty reason, or any other reason. An unmarked lock is indistinguishable from one a user wrote by hand, so it is reported and left alone. The existing backlog contains exactly such a lock, and it is correctly never reclaimed.

**Local-only commits protect the branch, not just the tree.** A clean worktree holding commits no remote has can be removed by a plain `git worktree remove` — git prints an empty `--porcelain` and does not object — leaving only the branch ref as the surviving copy of that work. So `localOnlyCommitCount > 0` is a hard precondition to eligibility, and branch deletion is a separate decision that requires content-level proof.

**The cap is measured over all managed worktrees but drawn only from eligible ones.** If 17 of 19 worktrees are blocked, the janitor does not delete 17 worktrees to reach a target of 2; it reclaims what it can and reports the rest with reasons. A cap that cannot converge is a reported state, not a licence to delete. The default cap is 20, above the 19 that exist, so the first sweep of the current backlog deletes nothing.

**Nothing blocks startup.** The `worktree-janitor` `ScopeStartup` contribution only schedules work: the first sweep runs under `setTimeout(0)` and every timer is `.unref()`d, so neither startup latency nor process lifetime depends on the janitor. Sweeps are mutually exclusive per scope, and failures are logged and retried on the next tick rather than thrown into startup.

Branch deletion proves content, not reachability. `git branch -d` and `merge-base --is-ancestor` both compare commit reachability and both call a squash- or rebase-merged branch unmerged, so neither can be the test. `branchLanded` tries tree equality first (`git diff --quiet`), then an aggregate `git patch-id --stable` comparison of the branch range against each target commit — which does match a squash — and only then `git cherry`, which settles the ordinary merge case. Anything unproven keeps the branch. Deletion happens only after the worktree directory is gone, since git refuses to delete a branch that is checked out, and a branch still checked out by a different live worktree is skipped.

The architecture invariant was revised to match, rather than left contradicting the code: a worktree becomes eligible for the managed cap only once it is idle, clean, free of local-only commits, and not locked by anyone other than Synergy, and a worktree failing any of those is reported with its reason.

Configuration lives in a new `worktree` domain (`57-worktree.jsonc`): `maxManaged`, `sweepIntervalHours` (default 6), and a `janitor` switch. `readWorktreeConfig()` resolves it through `ConfigExtensions.readField`, so the runtime does not hard-code where the value came from.

Two consolidations ride along because the new code would otherwise be a third copy of the same logic. `CortexWorkspace.cleanup` now calls the exported `localOnlyCommitCount` instead of running its own `git rev-list --count HEAD --not --remotes`, which was missing the remote-presence guard entirely. `patchIdOf` streams its diff through stdin via `Bun.spawn` rather than interpolating a caller-supplied command string into a shell.

`git-health` was corrected to the same standard: `gc_needed` thresholds derive from `git config --get gc.auto` (falling back to 6700, warning at a quarter of it), the branch advisory no longer recommends a command that cannot work after a squash merge, and a cheap `unpushed` dimension reports local-only work directly.

## Alternatives considered

**Keep `collectGarbage` and wire it up.** Rejected: its `unlockStale` clears locks it does not own, its removal could never succeed on a locked tree, it ignored the ordinary idle case, it had no branch step, and its use of `list()` makes it unaffordable on a tick. Wiring it up would have shipped a cold-worktree deleter with a user-lock hazard.

**Rewrite the whole garbage collector.** Rejected. `decide()`'s shape was already sound; the two real errors were consulting the in-process `activeLocks` map for a cross-process decision, and the unconditional unlock. Targeted correction preserves the reviewed structure and keeps the diff reviewable.

**Have `decide()` consult the in-process lock map.** Rejected: `activeLocks` is process-local and cannot see a turn running in another Synergy process, so a lock held there would read as free. Evidence is passed in by the caller instead, which also makes `decide` pure and cheap to test.

**Enforce the cap by deleting the oldest worktrees regardless of state.** Rejected outright: this is the path that destroys unpushed work, and it is precisely what the guards exist to prevent.

**Clear locks the janitor does not recognize, to reclaim more.** Rejected. An unmarked lock cannot be distinguished from a deliberate user lock, and clearing one silently defeats the documented purpose of `git worktree lock`.

**Reclaim dirty worktrees instead of reporting them.** Rejected: uncommitted changes are unrecoverable after removal, and reporting `dirty` is the signal that a human should look.

**Only advise, never reclaim.** Rejected: it does not bound growth, and the user chose a cap-based route aligned with the reference implementations that set this expectation.

**Put the first sweep on the startup critical path.** Rejected: a large backlog would then delay every project start, and a slow or failing sweep would become a startup failure.

**Use `list()` for the sweep and accept the cost.** Rejected: `directorySize` walks every checkout — measured at 29 GB for 20 worktrees — which is not viable on a repeating tick.

**Run the sweep on every prompt or creation.** Rejected for creation-adjacent sweeps: a creation must not fail or block because cleanup could not converge. The cap is also checked after creation, but asynchronously and without gating the result.

**Ignore the invariant and ship the janitor anyway.** Rejected: an authoritative document contradicting shipped behavior is worse than either choice alone, so the sentence was revised to state the actual precondition rather than left stale.

## Consequences

Managed worktrees are now bounded, and the two ways to lose work through cleanup — deleting a tree holding unpushed commits, and clearing a lock a user set — are both closed by construction rather than by intent. Growth becomes visible: an unreclaimable worktree is reported with a machine-readable reason, so "19 worktrees, 2 eligible, 17 blocked: 3 dirty, 12 with local-only commits, 2 running" is an observable state instead of a silent pile-up. The backlog itself is explicitly untouched: the default cap of 20 exceeds the 19 present, so the first sweep removes nothing and the user cleans that up by hand.

Costs and boundaries. **A cap that cannot converge stays uncomfortable.** If most worktrees are clean but hold unpushed commits, the cap will not be reached, and the design accepts that over deleting work — this is why the prompt-level hygiene advice matters operationally: once work is pushed, `local_only_commits` stops applying and the worktree becomes reclaimable. **Cross-process liveness remains unprovable.** `activeLocks` and `activeUses` are process-local, so the janitor cannot see a turn running in another Synergy process; the dirty check runs before any mutation, the running-session check uses `SessionManager.isRunning`, and the exposure is limited to a worktree that is idle, clean, and unpushed-free. **Branch deletion can miss.** A squash that required conflict resolution rewrites content, so the patch-id comparison will not match and the branch is kept. The algorithm only ever under-deletes. **The stale-registry reconciliation uses `-f -f`**, which is acceptable only because the directory no longer exists and is gated on a Synergy-managed registry path; no unmanaged path is ever touched that way. **`gc_candidate` is now write-only.** Three call sites still mark it and nothing reads it; it was retained rather than torn out to keep this change's blast radius bounded, and removing it is a natural follow-up. **Deferred**: the three separate cleanup-decision functions (`decide`, `getCleanupRecommendation`, and the Web panel's raw `item.dirty`) remain ununified by explicit decision, as does prompt-level enforcement of commit/push hygiene — the prompt advises, it does not block.

Coverage. `packages/runtime-local/test/workspace/worktree-janitor.test.ts` pins stale-registry reconciliation, that dirty and foreign-locked worktrees are skipped rather than removed, that a Synergy-marked lock is reclaimable while an unmarked one is not, that a running binding blocks reclamation, cap arithmetic over the oldest `lastUsedAt`, and each `decide` guard. `packages/runtime-local/test/workspace/worktree-lock.test.ts` pins lock provenance including under a non-English locale. `packages/workbench/test/project/git-health.test.ts` pins the derived `gc.auto` thresholds, the corrected branch advisory, and the `unpushed` dimension.
