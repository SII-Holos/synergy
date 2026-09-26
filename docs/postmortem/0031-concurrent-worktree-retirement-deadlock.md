# Concurrent Worktree Retirement Deadlock

## Executive summary

Concurrent cleanup in independent repositories could stall until a test or caller timed out. Each task held a directory's exclusive lifecycle claim before requesting a broader native Git write claim. The overlapping command requests waited on each other's directory claims. Local isolated tests and several full CI runs passed because the overlap was narrow. Admission now reserves broader writes before directory exclusion and rejects later expansion.

## Summary

The Linux runtime shard twice timed out while cancelling an active checkout hook. Subsequent native and product workspace tests also failed after the test runner terminated unfinished processes. Isolated Linux tests, full native batches and fresh-process concurrency repetitions initially passed. Temporary redacted CI claim snapshots captured only successful runs and could not establish a cause.

## Timeline

- On 2026-09-23, two CI runs reported the checkout cancellation timeout; successful reruns remained inconclusive.
- Concurrent native checkout cancellation and product worktree removal reproduced the failure in a native Linux container restricted to two CPUs.
- The ownership ledger showed two active exclusive directory claims and two waiting host-wide process claims. No native command had started for either waiting request.
- Deterministic regression tests reproduced unsupported footprint expansion and nested file-write self-dependency before implementation changes.

## Root cause

The lifecycle claim covered only the directory being retired. Git branch deletion retained its conservative host-wide footprint because it could execute hooks. Both tasks could acquire their disjoint lifecycle claims before requesting those commands. Admission checked ownership ancestry but did not require the broader footprint to have been reserved first. A separate nested-write path reacquired its task reservation instead of using the retirement owner.

Test timeouts then interrupted cleanup; the resulting failures obscured the first wait cycle. Increasing timeout values would only delay the same cycle. Fixture cleanup now aborts and drains its owned creation on readiness failure, but that change alone did not repair the product deadlock.

## Guardrails added

- [Admission order and rejected alternatives](../decisions/implemented/bug-fix/2026-09-23-workspace-retirement-admission-order.md).
- [Coordinator tests](../../packages/local-runtime/test/workspace/coordinator.test.ts) reject global and broader bounded footprints beneath disjoint retirement claims.
- [Task ownership tests](../../packages/local-runtime/test/workspace/task-access.test.ts) perform a real file write through retirement and reject reservation expansion and handoff.
- [Worktree behavior tests](../../packages/local-runtime/test/workspace/worktree-access.test.ts) retain cancellation, foreign-lock, new-commit, native-descendant and active-user checks.
- [Testing guidance](../../.synergy/skill/testing-guide/SKILL.md) requires cross-repository retirement overlap and captured ownership evidence for unexplained stalls.

## Lessons

Different directory names do not imply independent operations when a command can write outside those directories. Resource acquisition order must account for the complete command footprint before holding lifecycle exclusion. Passing repeated tests is useful evidence, but it does not explain an earlier timeout without observing the dependency that blocked progress.
