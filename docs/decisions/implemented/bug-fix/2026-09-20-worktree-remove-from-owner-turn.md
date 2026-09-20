# Decision Record: Remove a worktree from the turn that owns it

Status: implemented

## Problem

Leaving a worktree and removing it in the same action could never succeed from the turn that asked for it. `worktree_leave` with `cleanup: remove_if_clean` unbound the session first and then called removal, and removal was rejected by three independent guards, every one of which was reacting to the caller itself:

- The in-process use token. `SessionManager.run` wraps the whole turn in `SessionProjectHealth.withWorktree`, so `beginRemoval` saw an active token whose value was the calling session.
- The bound-session check. `leaveBoundSessions` added the caller's own session id to the set it was about to check, then rejected it for running — which it was, because it was executing that call.
- The git-level lock. The turn takes `git worktree lock` before running and releases it in its own `finally`, so the lock was always held while a tool body ran, and git refuses to remove a locked working tree.

The consequences were asymmetric and silent. The unbind had already succeeded, so a retry reported "Already on the main checkout" and the directory was abandoned with no owner; the caller never learned that cleanup had failed. On a machine that had accumulated 19 managed worktrees and 32 GB, this is the difference between cleanup happening and never happening.

A fourth defect hid the recovery path. `lock()` decided "already locked" by matching `/already locked/i` against git's stderr. Git localizes that message, so on a `zh_CN` runtime it read `已被锁定`, the match failed, and the function threw `LockFailedError` instead of reporting the existing lock. No test caught it because the test environment forces `LC_ALL=C` while the server does not pin the locale.

## Decision

Removal is told, explicitly, when it is being asked by the turn that owns the worktree, and it releases that turn's git lock before touching git.

`Worktree.remove` takes a second internal parameter, `{ insideCallerTurn?: boolean }`, and both call sites — the `worktree_leave` tool and `session-control`'s `worktree_leave` action — pass it. The flag is deliberately **not** part of `RemoveInput`: that schema carries a `ref` and reaches OpenAPI and the generated SDK, and exposing "exclude the running session from the guards" to an HTTP caller would both widen the contract and hand out a footgun.

When the flag is set, three things change, and only for the calling session:

- `beginRemoval(info, excludeSessionID)` drops entries whose value equals the caller's session id. Anonymous uses (no session attached) remain blockers, so a use token that cannot be attributed still prevents removal.
- `leaveBoundSessions` skips the running check for the caller alone, while still unbinding it in the loop below. Every other bound session is still rejected if it is running.
- `remove()` calls `releaseLockForRemoval(path)` before `git worktree remove`. This is the load-bearing step: without it git refuses the removal at every force level except `-f -f`.

`-f -f` is rejected as the mechanism, not merely as a style preference. After it succeeds the tree is gone, and the turn's own `finally` then calls `git worktree unlock` on a path that is no longer a working tree; `unlock()` throws `LockFailedError` on a non-zero exit, and a throw from that `finally` replaces the turn's return value and fails an otherwise successful turn. Releasing the lock first makes the turn's `finally` a no-op, which is the property `unlock()`'s early return on absent state already provided.

Lock provenance became explicit so that a stuck lock is recoverable without guessing. `lock()` writes `--reason synergy:v1:session=<id>`, which git reports verbatim in `worktree list --porcelain` — a channel git does not translate, unlike its stderr. "Already locked" is now decided by reading that porcelain state rather than matching message text, and a lock already on disk is recorded as `markerOwner` only when its reason carries the marker. `unlock()` clears the on-disk lock only when this process acquired it and the current reason matches its recorded reason, so a lock a user set by hand survives a session that merely ran in the worktree. `releaseLockForRemoval` clears both flags, otherwise the turn's later `finally` would still try to unlock a removed tree.

The tool-level outcome for the caller changed with it. Leaving always succeeded even when cleanup did not, but the failure was invisible; it now marks the worktree `gc_candidate` and reports `performed: false` with the error and `cleanupDeferred: true`. The dirty probe keeps its tri-state — `dirty: undefined` means the probe could not answer, which is neither "clean" nor "dirty", and is now reported as `unknown_dirty` instead of being collapsed into `dirty`.

## Alternatives considered

**Only have the tool release its own lock.** Necessary but insufficient on its own: `beginRemoval` and `leaveBoundSessions` still reject the caller's own turn, so removal would still fail. Retained as one step of the chosen route rather than as the route.

**Use `-f -f`.** Rejected for the reason above: it converts a completed cleanup into a failed turn by making the turn's own `finally` throw, and it silently defeats the documented purpose of `git worktree lock`.

**Defer removal until after the turn ends.** Would require a post-turn hook in the session manager, which should not know about worktrees; it makes the tool's result asynchronous and therefore not deterministically testable, and it loses to the immediate re-drive a session performs after finishing work.

**Rebind the session when removal fails.** Actively harmful. `leave` has already set the session workspace to main and refreshed the overlay, so rebinding to the worktree makes `assertExecutionContext` compare an expected worktree against an actual main and abort the turn.

**Fold leave and remove into one operation.** Cleaner ownership, but it changes `leave`'s return shape, which the HTTP route and the CLI command both consume. The internal flag buys the same safety without moving a public contract.

**Put `insideCallerTurn` on `RemoveInput`.** Rejected: it would reach the generated SDK and let a remote caller opt out of the guards that exist to stop exactly that.

**Infer the caller instead of passing a flag.** Inferring "the caller is one of the bound sessions" would silently rewrite an existing test that passes a session id while that session holds a lease and expects to be refused.

## Consequences

Leaving a worktree with cleanup from inside a session now removes it, and the directory stops being abandoned. Cleanup failure is visible and deferred to the janitor instead of being reported as success. A user's own `git worktree lock` is no longer at risk from a session that ran there, and a lock acquired by another process is preserved even when it carries a Synergy marker. The locale fragility is gone: lock state comes from porcelain, and a `zh_CN` runtime behaves like a `C` one.

Costs and boundaries. Three fields on the removal path now depend on a flag that a future caller must remember to pass; a new call site that omits it will keep the old self-rejecting behavior. Two flags on `LockState` must clear together in `releaseLockForRemoval` — clearing only `synergyAcquired` reintroduces the throwing `finally`. `activeLocks` and `activeUses` remain process-local, so a second Synergy process running a turn in the same worktree is invisible to these guards; the window where the lock is released before the git remove is milliseconds, and it only opens for a worktree the caller explicitly asked to leave and remove, with the dirty check performed before any mutation. The Cortex child-task pulse is untouched, as is `assertWorktreeSessionIdle`, which must keep refusing HTTP callers that target a running session.

Coverage. `packages/product-runtime/test/project/worktree.test.ts` pins removal from the caller's own running turn, that another running session is still refused inside a caller turn, and the two pre-existing refusals. `packages/runtime-local/test/workspace/worktree-lock.test.ts` pins the marker round-trip into porcelain, that "already locked" is reported under both `zh_CN.UTF-8` and `C`, that only a lock acquired by this process is releasable and replacement locks survive, and that an unlock with no in-process state never throws. `packages/product-runtime/test/tool/worktree-leave.test.ts` pins the deferred-cleanup metadata and the `unknown_dirty` distinguishing.
