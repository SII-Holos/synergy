# Decision Record: Synchronize credential-lock workers with parent messages

Status: implemented

## Problem

The credential-lock serialization test observes the exact intermediate log `first:start` before launching a second process. The first process appends its completion after 100 milliseconds, so a delayed parent can miss readiness and report a five-second startup failure even when the worker completed successfully. Startup failures also precede the test's cleanup block.

## Decision

The first worker announces lock acquisition through IPC and holds the lock until the parent explicitly releases it. The second worker announces its attempt before entering the same public credential-lock operation. The parent retains each readiness message in a promise, releases the first owner after the second worker starts, and verifies both exit codes and the complete serialized write order. Child stderr is drained from startup, premature exit rejects readiness, and an after-test hook stops and drains all owned workers. Homes live under the preload-managed fixture root.

## Alternatives considered

**Increase the polling deadline.** A longer deadline cannot recover an intermediate log state that has already disappeared.

**Accept a log prefix.** This avoids missing readiness but permits the first worker to finish before the second starts, reducing the test to two sequential writers without controlled overlap.

## Consequences

The test retains real cross-process credential locking and removes correctness dependencies on scheduler speed. IPC adds explicit fixture coordination; a generous test timeout remains as deadlock detection. Product locking behavior and coverage thresholds are unchanged.
