# Decision Record: Bound maintenance statements to a fixed chunk budget instead of scaling their deadline by database size

Status: implemented

## Problem

A running backend terminated itself because one SQLite statement held the worker past the budget that decides the worker's fate. The statement was retention's owner enumeration, and the store had grown to 42.9 GiB with 15,081,375 rollout rows; against that store the statement took 182 seconds. The worker serves every statement inline on one event loop, so those 182 seconds were 182 seconds in which it could not answer anything else.

The deadline for that class of statement was computed from the database's own size:

```
deadline = Math.min(2_147_483_647, 600_000 + Math.ceil(bytes / 1024 ** 2) * 1000)
```

At 42.9 GiB this resolves to 43,792,000 ms — **12.16 hours**. The formula was not careless. It encoded a real requirement: `PRAGMA integrity_check` revisits every index entry, and `CREATE INDEX` reads every row, so on a large store those statements genuinely outlive an ordinary 30-second deadline, and a DDL statement killed at that deadline is rolled back and then repeated on the next open, forever.

But it expressed that requirement in a way that is incompatible with the process's own failure policy. The driver's terminal budget was `30_000 + 3 × 30_000 = 120_000` ms, composed of the ordinary deadline, the probe budget, and the probe attempt count. The same file therefore believed a statement could legitimately run for twelve hours while treating any statement over two minutes as proof the worker was unrecoverable. The larger the store grew, the more licence the formula granted one statement to occupy the loop and the more certain the fatal path became.

The formula also hid the contradiction from review. It produced a plausible-looking number that was never compared against the number that actually decided the outcome, because neither was written as a limit — both were derived, and nothing asserted their relationship. `onMaintenanceBudget` reported the result to callers, and the only test asserted a lower bound (`>= 600_000`), so a value eleven orders of magnitude past any enforceable bound passed.

Separately, `retention`'s `pruneTree` issued its record removal as one statement whose cost grew with the subtree. Retention prunes whole owner subtrees, and a subtree can hold millions of rows, so that statement had the same unbounded shape as the enumeration.

## Decision

Statements no longer buy themselves a longer deadline by growing the database. Every statement is bounded by one of three fixed budgets resolved from configuration: `requestDeadlineMs` for ordinary work (default 30 s), `chunkBudgetMs` for `reclaim` — the only operation that can be split — (default 30 s, clamped to `hardCeilingMs / 4`), and `engineBudgetMs` for the statements that cannot be split at all (the ceiling itself, default 3600 s). The size-scaled formula and its `2^31 − 1` clamp are removed.

Because a fixed budget can only be enforced if the work fits inside it, every path that could exceed it is chunked:

- `retention`'s `pruneTree` deletes in bounded batches of `PRUNE_CHUNK = 4096`. Each round is its own statement, so the work is interruptible between rounds and no single statement grows with subtree size. The node-tree recursion reads the tree, which stays intact until every record in the subtree is gone, so a bounded batch is still exact.
- `reclaim` already looped `incremental_vacuum` under both a page cap and a time budget, and `sqlite-maintenance.ts` already bounded its delete loop with `DELETE_CHUNK` and a deadline. Those shapes are the model the rest now follows.
- Index builds remain single statements, because SQLite offers no way to chunk `CREATE INDEX`. They are one of the three statements that cannot be chunked or cancelled — `VACUUM` rewrites every page, and `PRAGMA integrity_check` is a single engine call with no progress callback — and all three grow with the store, so they are bounded by `engineBudgetMs`, which is `hardCeilingMs` (default 3600 s), rather than by any chunk deadline. Failing one of them at a chunk deadline would roll back work that would otherwise have finished, and an index build failed that way is rolled back and then rebuilt on every open, so these three are sized by the operator rather than by the database.

The relationship between the budgets is asserted rather than documented. `StorageBudgets` clamps `chunkBudgetMs` to `hardCeilingMs / 4`: a configuration that would let one chunk reach the ceiling is reduced instead of honoured, so the invariant holds by construction. `packages/harness/test/storage/budgets.test.ts` asserts it for the defaults, for a configuration that tries to raise the chunk budget far above the ceiling, for a raised ceiling, for a degenerate ceiling, and for an ordinary statement and a probe configured to outlive it, and `packages/harness/test/storage/verification.test.ts` asserts that a maintenance statement's budget no longer changes when the database grows.

## Alternatives considered

**Raise the worker ceiling to accommodate the 12-hour deadline.** This trades one failure for another. A worker that cannot answer for hours is unusable regardless of what the driver calls it, and the store holds the single writer, so every other caller waits behind it. It would also make a genuinely hung worker take hours to detect.

**Keep the size-scaled deadline but cap it below the terminal budget.** This bounds the damage without addressing the cause, and it makes the cap the new source of the same class of bug: a statement that needs longer than the cap on a large store would be killed and retried forever, which is exactly the failure the original formula existed to prevent.

**Cancel the long statement with `sqlite3_interrupt` or a progress handler.** These are the correct primitives for bounding a statement's runtime, and they are unavailable: `bun:sqlite` exposes no interrupt and no progress-handler binding, and on macOS Bun links Apple's system SQLite built with `OMIT_LOAD_EXTENSION`, so a native extension route is closed. A progress handler can also be starved for tens of seconds on a full-scan aggregate, which is the exact statement shape at issue. Prevention through chunking is what remains.

**Move maintenance to a second connection or a separate process.** [Storage retention and incremental vacuum](../architecture/2026-09-18-storage-retention-and-incremental-vacuum.md) settled this: the single-owner process lock and `StorageOwnershipError` fencing deliberately prevent a second owner from opening the file, and a second connection would reintroduce the multi-writer WAL hazard. Maintenance must run in the one worker.

**Give each maintenance operation its own budget constant.** Several constants would drift, and the invariant that matters is a single relationship between the chunk budget and the ceiling. One clamped value keeps that relationship checkable in one place.

## Consequences

No statement can occupy the worker past the ceiling any more, because no statement's budget is derived from anything that grows. The failure mode that terminated the runtime — one statement outliving the budget that decides the worker's fate — is structurally unreachable rather than merely unlikely.

The cost is that no single chunk may exceed `chunkBudgetMs`, so long splittable work — a `reclaim` pass, a retention prune — is permitted only as a sequence of bounded rounds. An operator who needs a longer round must raise `chunkBudgetMs` explicitly, and `StorageBudgets` clamps it to `hardCeilingMs / 4` instead of honouring a value that would let one chunk reach the terminal path, so the decision is forced into the open rather than absorbed by a formula. The three statements that cannot be chunked are not charged that cost: their expense grows with the store, so `engineBudgetMs` bounds them by the ceiling itself rather than by a chunk deadline, because failing one at a chunk deadline would roll back work that would otherwise have finished — and, for an index build, would rebuild it on every open. Chunking `pruneTree` also converts one statement per subtree into one per 4096 records, which is more round trips for the same total work; the trade is that each round is bounded and the pass can be abandoned between them.

`packages/harness/test/storage/budgets.test.ts` covers the invariant directly. `packages/harness/test/storage/verification.test.ts` covers the deadline behaviour: a maintenance statement keeps a fixed budget while the database grows, ordinary statements keep their own budget, and the chunk budget leaves a full margin below the ceiling. The retention suite covers the chunked prune: pruning an expired owner still reclaims records and node paths without touching a live owner, and node rows are still drained from the leaves up.
