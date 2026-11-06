# Decision Record: Anchor git-health advisories to git's own thresholds

Status: implemented

## Problem

The git-health advisories told the agent things that were either false or impossible to act on, which is worse than saying nothing: an agent that follows a failing command learns to ignore the signal entirely.

Three separate defects, all in `packages/workbench/src/project/git-health.ts`:

**The garbage-collection threshold was a false alarm.** `checkGcNeeded` reported `critical` at 200 loose objects. Git's own effective threshold is `gc.auto`, which defaults to 6700 — so the advisory fired at roughly 3% of the condition it claimed to describe. The machine that motivated this work held 297 loose objects, 4.3% of the real limit, and the `<git-health>` block injected into the running agent's context was reporting a critical repository condition that did not exist. A warning that fires when nothing is wrong trains the reader to dismiss the channel.

**The branch advisory recommended a command guaranteed to fail.** After a squash merge the branch's tree can be byte-identical to the target and `git branch -d` still refuses, reporting the branch as not fully merged — because `branch -d` checks commit reachability, and a squash creates a new commit that the branch tip is not an ancestor of. So the advisory pointed at `git branch -d` for branches that were, by content, already merged. This was verified directly on git 2.55.0: identical trees, exit 1.

**There was no signal for the one condition that actually costs work.** A checkout holding commits no remote has is the state where cleanup destroys the only copy — `git worktree remove` deletes a clean worktree holding local-only commits without objection, leaving only the branch ref. Nothing in git-health reported it, so the agent had no way to know that finishing its work required a push.

## Decision

Git-health advisories derive their thresholds from git's own configuration, name conditions that are actually actionable, and report the one condition that endangers unfinished work.

`checkGcNeeded` now reads the effective `gc.auto` via `git config --get gc.auto` and derives both levels from it: `warn` at a quarter of the threshold and `critical` at the full value, with 6700 as the fallback when the key is unset. It returns nothing below the warn level. The message names the effective threshold so the number in the advice matches the number git will act on.

Parsing `gc.auto` needs care that an exit-code check would miss: an unset key exits 1 with empty output, but a key set to empty, to `0`, or to a non-numeric value exits 0 with that literal value on stdout. `0` is meaningful — it disables automatic gc, so git would never collect and the fallback would be wrong to assume. The value is therefore validated numerically and treated as the fallback unless it is finite and positive.

`checkExtraBranches` no longer recommends `git branch -d`. It points at the worktree cleanup path, which decides branch deletion from content-level evidence rather than reachability, and names the reason: squash and rebase merges are not detected as merged by ancestry checks.

A `unpushed` dimension was added. It is deliberately cheap — one `git rev-list --count HEAD --not --remotes` — so it can run on the cached scan without adding a directory walk. It is gated on remote-tracking refs existing, because `--not --remotes` does not mean "not pushed" when there is no remote at all: with nothing to subtract, the count degenerates to the entire local history and returns 1 for a fresh repository. Warning there would fire on every new repository.

The prompt carries a matching advisory bullet: commit and push finished work to the remote before finishing, and if work must stay local, say so explicitly rather than leaving it silent. This is advice, not enforcement — the runtime does not block on unpushed work — but it is the operational counterpart to the janitor's `local_only_commits` guard, since a pushed branch is what makes a worktree reclaimable.

## Alternatives considered

**Keep the 200-object threshold and just relabel it.** Rejected: the number was wrong, not the wording. Any fixed constant is wrong on a machine that configured `gc.auto`, and `gc.auto: 0` makes it wrong in the opposite direction.

**Read `gc.auto` and warn at a fixed multiple of it.** Rejected as arbitrary: git already defines the threshold and its own behavior at it, so deriving both levels from that value keeps the advice answerable by git itself.

**Detect unpushed commits in the per-turn invoke path instead.** Rejected: that path runs every model iteration, and probing there adds an uncached git subprocess to the hot loop. git-health already caches and already has the scan the dimension belongs to.

**Warn on unpushed commits unconditionally.** Rejected: it fires on every repository with no remote, which is a normal state for a scratch or fresh checkout, and would be the same class of false alarm being fixed here.

**Have the branch advisory recommend `git branch -D`.** Rejected: it converts a wrong suggestion into a destructive one. The safe path is content-level proof, which the janitor performs, so the advisory points there instead of naming a command the agent should not run blind.

**Enforce the push requirement in the runtime.** Rejected: the user chose advisory-only on this axis. Blocking or erroring on unpushed work would make the runtime refuse ordinary local commits in a repository the user never intended to push.

## Consequences

The `<git-health>` block now reports conditions that are real and actable. A repository with 297 loose objects and default configuration produces no gc advisory, matching git's actual behavior; a repository that lowered `gc.auto` to 200 gets a correctly-calibrated warning at 50 and a critical at 200. The branch advisory no longer sends an agent into a command that fails on exactly the merge style this repository uses. The `unpushed` dimension surfaces the one state that silently costs work, and it does so only when a remote exists to have not received the commits.

Costs and boundaries. **`gc.auto` is read per scan**, so a scan now issues one extra `git config` call; this is a cheap local read on a cached path, not a directory walk. **The fallback of 6700 is a constant** and will drift if git changes its default; it is used only when the user has not set the key, and the message names the effective value so the advice stays checkable. **`unpushed` is gated on remote-tracking refs**, so a repository with a configured remote that has never been fetched produces no warning — the narrow choice, since warning falsely on remote-less repositories is the worse failure. **Git warns `garbage found` while counting hand-written loose objects**, which is why the existing count takes the maximum of git's count and an on-disk count. **Advisory only**: nothing here blocks a turn or refuses a commit.

Two sibling test files (`git-health-scoped-invalidation-contract.test.ts`, `git-health-session-stall-regression.test.ts`) declare a mirrored local `Issue` union and needed the new dimension added; they are type-level mirrors, so their assertions are unchanged.

Coverage. `packages/workbench/test/project/git-health.test.ts` pins that 100 loose objects with `gc.auto` unset produce no advisory, that `gc.auto 200` warns at 100 and escalates to critical at 200, that `gc.auto 0` takes the fallback, that the branch advisory neither contains `git branch -d` nor omits the squash reason, and that `unpushed` appears for a local-only commit and stays absent for a remote-less repository and a fully-pushed one.
