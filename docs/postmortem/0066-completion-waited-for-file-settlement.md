# Completion waited for file settlement

## Executive summary

A streamed reply looked unfinished while Workspace snapshots were captured, followed by another wait for its file card. The foreground completion projection was correct, but the lifecycle published its required segment end after snapshot work. Tests completed the ledger directly and missed that caller ordering. Completion tests must exercise the complete lifecycle while expensive dependencies are deliberately held.

## Summary

A recording from an isolated large installed dataset showed two distinct waits after visible text ended. Correlated runtime evidence placed terminal assistant persistence about 2.15 seconds before segment completion. Two Workspace endpoint captures occupied that interval; a subsequent summary job took about one second. The evidence did not establish a renderer long task during those waits.

## Timeline

- An earlier change separated foreground reply completion from detached Run accounting.
- A user recording on 2026-10-10 showed completion and file-card delays despite that projection.
- Correlating canonical message times, execution records and snapshot spans exposed capture before segment completion.
- Auditing adjacent waits found a global Part flush, repeated full-transcript summary reads, paired object-tree validation and model inference sharing the file-comparison queue.
- Controlled dependency gates reproduced completion and diff waits before the corresponding fixes.

## Root cause

Foreground status depended on an ended execution segment. The full lifecycle captured endpoints before ending that segment, so presentation inherited filesystem cost. Separately, a FIFO summary queue held the next checkpoint comparison until earlier title/body inference finished. Async scheduling alone did not remove serial dependencies inside the worker.

Summary jobs reloaded the transcript even though their model input required only one root and their aggregate already had a cursor. Snapshot ownership validated two largely shared object graphs separately. Processor finalization flushed unrelated Sessions, coupling one reply to other writers' latency and failures.

Installed-data acceptance exposed additional comparison costs: ownership checks reapplied Git repository configuration even with an initialized cache, and single-file metadata lookup enumerated unrelated tree entries. Repository initialization is limited to missing caches, and metadata queries use bounded batches of literal requested paths.

## Guardrails added

- [Lifecycle regression](../../packages/harness/test/session/turn-completion.test.ts) holds endpoint capture, checks foreground completion and retains eventual checkpoint and auxiliary accounting.
- [Summary regressions](../../packages/harness/test/session/summary.test.ts) hold inference across newer file comparisons, preserve same-root publication order and reject earlier-turn body hydration.
- [Processor regression](../../packages/harness/test/session/processor-retry.test.ts) rejects a global flush during reply finalization.
- [Snapshot regressions](../../packages/harness/test/snapshot/persistence.test.ts) batch paired validation and retain missing/corrupt object repair and cross-session ownership checks.
- [Architecture](../architecture/session-and-messages.md#settlement-and-synchronization), [decision](../decisions/implemented/bug-fix/2026-10-09-foreground-reply-completion.md) and [conversation verification](../../.synergy/skill/develop-frontend/references/conversation.md) document the ordering.

## Lessons

Audit from final provider data through durable message, segment, checkpoint, summary event and rendered footer. Keep required execution ordering distinct from presentation dependencies. Use held operations to prove independence on slow CI machines; report real installed-data timings separately. Do not remove integrity validation or release execution ownership merely to improve displayed latency.
