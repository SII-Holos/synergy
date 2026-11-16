# Continue admission outlived its observed pause

## Executive summary

A Continue request could clear a newer pause after waiting for the current execution to exit. The observed pause was checked before the wait, while publication used a later Session without repeating that check. Admission now revalidates after waiting and inside the transaction that releases the pause.

## Summary

Native continuation was being prepared for trusted command receipts. Inspection found that it retained the Session control lock during execution drain and could not cancel that wait. A real-lease regression replaced the pause while the request waited: the request returned `accepted` and released the newer pause. Another regression showed that cancelling the caller did not end its wait.

## Timeline

- A test held a real execution lease, started Continue and changed the pause before releasing the lease. The old request was accepted instead of returning `stale`.
- A cancelled continuation remained waiting until the held execution lease was released.
- Admission was split into an initial observation, a cancellable drain without the control lock, and revalidation under the reacquired lock and SQL writer.
- Native recovery and trusted receipt regressions verified rollback, actor retention, duplicate handling and restart alongside the changed path.

## Root cause

The control lock was treated as protection across a wait even though lifecycle pause writers do not all acquire it. A pre-wait predicate therefore did not establish the state at publication. The same structure encouraged an external receiver to wrap a wait and native Rollout operations inside its own SQL transaction.

## Guardrails

Behavioral tests in `packages/harness/test/session/resume.test.ts` hold actual execution and Inbox locks and inspect committed native records. They cover changed pauses, cancelled waits, commit cancellation, receipt failure and independent writer progress. The native entry rejects enclosing transactions, and trusted admission hooks join its own commit. The persistence Skill requires tests at both the wait and commit boundaries.

## Lessons

A lock protects only writers that participate in it. Recheck the observed identity after an asynchronous drain and again at the durable mutation point. Compose receipts at the native owner's transaction rather than moving its waits under another writer.
