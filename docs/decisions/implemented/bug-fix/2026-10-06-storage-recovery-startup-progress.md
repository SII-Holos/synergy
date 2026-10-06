# Decision Record: Separate Runtime readiness from subsystem progress

Status: implemented

## Problem

Completing domain migrations does not finish startup. Storage and execution recovery, configuration, extensions and service hooks still run, and HTTP may listen before the last hooks complete. Letting a subsystem completion restore the ordinary health deadline or accepting HTTP health alone misclassifies unfinished work. Instrumenting only the latest slow operation leaves the same defect at the next unreported await. See the [incident](../../../postmortem/0049-storage-recovery-startup-progress-gap.md).

## Decision

`RuntimeHandle.open` owns the lifecycle from initialization through successful return, including drainage of its maintenance observer. Its terminal readiness event is independent of detailed storage, migration and execution-history reports. Managed CLI forwards lifecycle work but holds readiness until its factory has returned, HTTP transport exists and shutdown monitoring is armed. Desktop requires both explicit readiness and successful health. A missing readiness record cannot silently fall back to HTTP-only admission; bundled hosts and runtimes share the startup protocol.

Runtime lifecycle stages cover every awaited startup interval. Component composition automatically reports completed extension, resident and finalization hooks; owners may report finer actual work through the optional callback. Counts are throttled while stage changes and terminal events are immediate. New awaits inherit the enclosing stage's inactivity deadline instead of falling back to the health deadline. Duplicate counts, repeated or regressive stages, and late subsystem progress cannot renew a stopped stage. After readiness, the startup state is terminal.

The Runtime also announces each storage recovery stage before awaiting it. The aggregate storage protocol carries interrupted-import recovery, attachment checks, resource recovery, quarantine loading and notification reconciliation. Storage completion is emitted only after those operations succeed. A migration summary describes only its runner, including on an already-migrated restart.

Artifact collection reports inspected references, pins, directory entries and collection work. Its bounded observer publishes outside retryable SQL callbacks, and repeated work advances the cumulative count. Registered resource recovery owners accept an optional callback for actual checked work; the registry additionally reports completed owners. Notification reconciliation advances after acknowledgment commits. The wire protocol includes no filenames, owner names, record contents or private identifiers.

The existing five-minute inactivity budget applies throughout Runtime startup. Silent work still expires with its stage and last count; a single legitimately long indivisible operation needs an explicit finite maintenance budget or actual work reporting. Ordinary health checks retain their 30-second deadline after readiness, and database maintenance retains its independent fixed budget. No periodic heartbeat renews either deadline. Explicit offline maintenance is supervised through process completion and keeps its own command mode. Recovery ordering, transactions, pins, permissions and persisted formats remain unchanged.

## Alternatives considered

**Raise the health timeout.** This makes the failure depend on a different history size and still presents storage recovery as an ordinary server start.

**Suppress the migration summary.** Keeping the previous migration visible would hide the actual operation and still provide no incremental progress during recovery.

**Wait while the child process is alive.** Process liveness cannot distinguish useful work from a deadlock. Actual progress and bounded silence remain required.

**Add progress only to the observed slow functions.** This improves detail but does not prevent a future await or startup hook from falling outside the supervisor's understanding of startup. The enclosing lifecycle and automatic component observations provide that coverage.

## Consequences

Startup producers and consumers share bounded lifecycle and storage stage values. Cross-package tests connect a real Runtime and SQLite store to CLI reporters and Desktop, covering delayed recovery, uninstrumented component hooks totaling more than five minutes, HTTP health before late-hook failure or cancellation, cleanup, retry and restoration of the health deadline. Electron verifies recovery and extension tasks and checked counts. Timing injection verifies waiting semantics without claiming measured engine throughput or reproducing a particular installation's exact slow operation.
