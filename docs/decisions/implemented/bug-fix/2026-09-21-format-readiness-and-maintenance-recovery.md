# Decision Record: Format readiness and maintenance recovery

Status: implemented

## Problem

An optional format rewrite could run during ordinary startup when incremental auto-vacuum was already enabled. After the atomic format swap, startup still waited for physical reclamation. Unknown-total copy progress was discarded, producing a five-minute no-progress failure even while work continued. Interruptions left users with neither a usable recovery action nor a reliable way to resume after ordinary writes changed the source.

## Decision

The central runner never executes maintenance migrations during ordinary startup. A read-only applied probe can reconcile the completion receipt of an already committed layout. Explicit maintenance uses exclusive storage ownership; Desktop invokes the same bundled CLI after checking for active work and stopping its own server.

Format publication and reclamation have independent completion states. Every copy phase checkpoints its cursor within the batch transaction. Source-mutation triggers fence staged copies, and unfenced historical staging is rebuilt. The final transaction validates the fence and commits all tables, indexes, format metadata and the reclamation checkpoint together. A committed format is usable before free pages are returned to disk.

Reclamation runs in bounded idle passes with persistent pause, pressure checks, failure backoff and shutdown draining. An offline CLI command can finish it explicitly. The shared progress schema accepts advancing counts with an unknown total; silence remains bounded by the existing startup and typed maintenance budgets.

Desktop exposes narrowly typed recovery actions restricted to its current main application or exact recovery document. Duplicate actions coalesce, conflicting actions are rejected, and late navigation cannot replace a newer document. A return action cancels maintenance and restarts committed data. Startup diagnostic export reads bounded redacted logs without opening either data or telemetry storage.

## Alternatives considered

**Increase startup timeouts.** Rejected because this leaves optional rewrites on the critical path, hides discarded progress, and still gives users no recovery path after a real failure.

**Treat incremental auto-vacuum as permission to rewrite.** Rejected because the pragma describes reclaim capability, not whether copying every record is necessary or acceptable during startup.

**Reuse staged copies after ordinary writes.** Rejected because the copied prefix may contain deleted or outdated records. A source fence preserves correctness at the cost of repeating staging when the source changes.

**Require physical reclamation before recording the format migration.** Rejected because the format transaction already establishes usable data. Disk cleanup can safely resume independently.

## Consequences

Ordinary upgrades avoid optional whole-store copying and reclamation. Large explicit maintenance can still take time and require space for staging. Returning to the app may cause a subsequent optimization to rebuild staging when data changes. Reclamation intentionally gives foreground work priority, so returning all free pages can take longer. Multi-namespace SQLite files are refused rather than risking replacement of another namespace's tables.

Regression coverage includes real SQLite interruption, post-interruption mutations, atomic rollback, fresh and historical layouts, independent reclamation, current-launch child failures, real Electron recovery controls, and a controlled maintenance interval beyond five minutes. See the [incident analysis](../../../postmortem/0022-optional-format-rewrite-blocked-startup.md) and [storage architecture](../../../architecture/agent-storage.md).
