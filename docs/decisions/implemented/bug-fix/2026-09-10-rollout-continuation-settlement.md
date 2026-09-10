# Decision Record: Serialize continuation admission with rollout settlement

Status: implemented

## Problem

A child completion can leave the persistent inbox before its continuation message is written. Rollout settlement can observe an empty inbox and an earlier terminal reply during that interval, close the run, and prevent both the continuation and subsequent queued tasks from executing. Checking only for any terminal reply also closes runs whose materialized continuation still needs a reply. Restart preserves this contradiction.

## Decision

Session invocation holds a per-session, per-root lock across steer drainage, materialization, the canonical needs-model-call decision, and execution-segment admission. Rollout reconciliation acquires the same lock before reading settlement state. Reconciliation also requires that the latest input for the root has a terminal reply. The admitted segment and its normal completion path retain responsibility for eventual settlement.

The registered migration `20260910-rollout-unanswered-continuation` changes incorrectly completed runs with unanswered effective-history input to `interrupted`. It appends the correction through the rollout journal and preserves input, evidence, timestamps, configuration, and queued tasks. The existing interrupted-run admission opens the next segment. Cancelled runs, failed runs, recording failures, and correctly completed runs remain unchanged. Migration reads owner-addressed message metadata and history events without relying on session-index hydration.

Before changing a run, the migration durably records a recovery intent under that owner's rollout storage. Startup discovers these intents alongside queued inbox tasks and uses `SessionDrive` and `SessionManager.wake` to resume the existing root even when no new task is queued. Discovery and failed wake attempts retain the intent; checking a settled, cancelled, failed, or superseded root removes it. Archived sessions and active rollbacks are not automatically resumed. Ordinary interrupted work without a migration intent retains the existing explicit-resume policy. No synthetic transcript messages are added.

Migration registration keeps history and progress imports type-only or deferred until execution. Static history imports reach session initialization through the manager and inbox, which otherwise exposes an incompletely initialized history module during cold startup.

## Alternatives considered

**Restart or repeated wake attempts.** The completed status and unanswered continuation are durable, so retries encounter the same rejection.

**Allow every completed run to reopen.** This weakens terminal evidence semantics and risks reviving intentional cancellations or unrelated completed work. The repair is restricted to the identified inconsistency and runs through the versioned migration runner.

**Check only inbox emptiness or only transcript state.** Neither alone protects the transition between those representations. Admission and settlement share a lock as well as a canonical reply predicate.

## Consequences

Pending user tasks retain their order and execute after the recovered continuation. Reconciliation waits for admission to finish before checking the inbox and transcript. Upgrade scans rollout metadata and reads message metadata only for owners with eligible completed runs; it does not load tool payloads or rewrite historical calls. Behavioral tests cover materialization-time reconciliation, persisted-state recovery without queued tasks, failed-wake retries, repeated startup, unaffected terminal states, and migration idempotence. Fresh-process migration registration tests verify the cold import graph.

Product recovery integration tests apply the domain migration to their owned session. The Harness migration suite separately verifies global runner registration, ordering, and idempotence, so unrelated incomplete test records cannot contaminate recovery assertions. Production migration scans retain strict storage error handling.
