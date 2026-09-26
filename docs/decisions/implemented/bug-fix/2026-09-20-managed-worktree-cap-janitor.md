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

`sweep()` replaces `collectGarbage`, `pruneStaleRegistry`, and the old `cleanupState`. It reads a lightweight `inventory()` — `git worktree list --porcelain` plus the registry, with no directory sizing — so a background tick never walks the checkout. Each managed worktree is judged by the pure function `decide(info, evidence)`, which returns either eligible or a specific keep reason, in this order: not managed (`external`), main (`main`), locked (`foreign_lock` or `synergy_lock`), bound to a running session (`running`), dirty (`dirty`), dirty-but-unprobed (`unknown_dirty`), unable to verify commit reachability (`unknown_commits`), or holding local-only commits (`local_only_commits`).

Four properties follow, and each is load-bearing:

**The janitor never clears an on-disk lock.** A Synergy marker proves provenance, not that its holder exited. Automatic reclamation preserves both Synergy and foreign locks. Explicit owner-turn removal can release only a lock this process acquired whose current reason still matches its recorded reason.

**Local-only commits protect the branch, not just the tree.** A clean worktree holding commits no remote has can be removed by a plain `git worktree remove` — git prints an empty `--porcelain` and does not object — leaving only the branch ref as the surviving copy of that work. With no remote refs, the whole reachable history remains local-only. Probe failures remain unknown and block removal. Thus a verified `localOnlyCommitCount === 0` is a hard precondition to eligibility, and branch deletion is a separate decision that requires content-level proof.

**The cap is measured over all managed worktrees but drawn only from eligible ones.** If 17 of 19 worktrees are blocked, the janitor does not delete 17 worktrees to reach a target of 2; it reclaims what it can and reports the rest with reasons. A cap that cannot converge is a reported state, not a licence to delete. The default cap is 20, above the 19 that exist, so the first sweep of the current backlog deletes nothing.

**Nothing blocks startup.** The `worktree-janitor` `ScopeStartup` contribution only schedules work: the first sweep runs under `setTimeout(0)` and every timer is `.unref()`d, so neither startup latency nor process lifetime depends on the janitor. Sweeps are mutually exclusive per scope, and failures are logged and retried on the next tick rather than thrown into startup.

Branch deletion accepts ancestor reachability, exact tree equality, or an aggregate patch-id matching a target commit. Otherwise it checks individual patch equivalence only when the unlanded range contains no merge commits: `git cherry` ignores merge-only resolutions and cannot prove those changes landed. Unproven branches remain. Git still refuses deletion while a branch is checked out elsewhere.

The architecture invariant was revised to match, rather than left contradicting the code: a worktree becomes eligible for the managed cap only once it is idle, clean, free of local-only commits, and unlocked, and a worktree failing any of those is reported with its reason.

Configuration lives in a new `worktree` domain (`57-worktree.jsonc`): `maxManaged`, `sweepIntervalHours` (default 6), and a `janitor` switch. `readWorktreeConfig()` resolves it through `ConfigExtensions.readField`, so the runtime does not hard-code where the value came from.

Explicit removal, cap enforcement and stale reconciliation share the in-process removal gate. The sweep refreshes bindings and eligibility while holding that gate, migrates idle sessions before deleting their workspace, and never excludes anonymous users. Missing managed entries are removed individually after lock and liveness checks; there is no repository-wide prune that could discard an external checkout. `patchIdOf` passes diff bytes through stdin.

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

Costs and boundaries. A cap may remain exceeded when work is dirty, unpublished, locked or unverifiable. A stale Synergy lock requires explicit operator recovery because cross-process liveness is not established by the marker. Git cannot coordinate arbitrary concurrent filesystem writers, so the ordinary clean-worktree removal check remains the final guard. Squashes whose conflict resolutions differ are conservatively retained. The existing `gc_candidate` marker is not itself permission to delete.

Coverage. `packages/local-runtime/test/workspace/worktree-janitor.test.ts` pins stale-registry reconciliation, that dirty and foreign-locked worktrees are skipped rather than removed, that both Synergy-marked and foreign locks survive automatic reclamation, that a running binding blocks reclamation, cap arithmetic over the oldest `lastUsedAt`, and each `decide` guard. `packages/local-runtime/test/workspace/worktree-lock.test.ts` pins lock provenance including under a non-English locale. `packages/workbench/test/project/git-health.test.ts` pins the derived `gc.auto` thresholds, the corrected branch advisory, and the `unpushed` dimension.

Review regressions cover anonymous and named active uses, repositories without remote refs, external missing checkouts, idle session rebinding, replaced locks, merge-only branch changes, and awaiting an active sweep during disposal.
