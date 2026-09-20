# Decision Record: Bounded historical storage preparation

Status: implemented

## Problem

A released JSON Home can contain thousands of Sessions and Git object repositories. Treating optional housekeeping, per-owner transformations and global safety checks as one startup barrier makes time to new work scale with the entire history. Partially copied SQL rows also require an admission rule independent of which API happens to read them.

## Decision

Migration registrations declare startup, per-Session, after-convergence or maintenance execution. The runner validates a qualified cross-domain dependency graph and normalizes historical single/domain ledgers before choosing a protocol. Unknown shared work remains a startup barrier. Existing manifests retain their protocol; eligible new manifests use segmented format 4.

The ordinary `Storage` transaction surface hides unpublished owners at the SQL query boundary and rejects their point reads and mutations. Import and registered migration callbacks have a named internal access scope. A durable pending-owner marker, canonical records, derived indexes and publication receipts change under the same writer. Cleanup follows publication and retains its own resumable intent. Existing deferred stores acquire pending markers through a registered storage migration.

Owner import streams sealed entries with bounded row/byte batches and immutable artifact pins. Owner schema walks also observe cancellation between records; orphaned tool repair streams candidates instead of accumulating the entire conversation. The Runtime admits one background owner and at most two directly requested owners. Foreground priority, manual pause, disk reserve and uncheckpointed WAL pressure interrupt or yield background work; aborting a Git subprocess releases its lease instead of parking a paused job while it holds that lease. Receipts and sealed backup groups remain retryable. Unsupported oversized records and malformed data retain their source and require repair.

Format 4 seals global bytes without walking legacy snapshot objects during startup. Session sources move into the frozen recovery tree; legacy Git repositories retain their original paths and acquire a durable mutation guard. Each snapshot Scope seals independently in the background. A requested owner transfers only its required snapshot closure into the current store; original objects remain protected until all owners and backup segments converge. Restoration rewrites contained absolute alternates to relative paths and recreates Git's required empty directories. External object dependencies prevent an independent-backup claim.

Runtime readiness, historical convergence and independent backup completeness are separate states. Web preparation starts asynchronously, polls through generated SDK methods, and provides a workspace return action and recoverable-error retry. Background controls are available through HTTP and the CLI. Quarantine is never cleared by the retry action. Existing blocking Session reads return a structured preparation response after a short wait while the durable job continues.

Full SQLite VACUUM conversion is optional maintenance, invoked with `migration run --maintenance`; already incremental and PostgreSQL stores can finish its no-op at startup. Necessary maintenance reports the actual finite worker budget with a monotonic operation number. Desktop accepts each operation once and uses a monotonic clock; repeated announcements cannot keep a stalled operation alive indefinitely.

## Alternatives considered

**Permanent JSON/SQL dual business storage.** This retains two mutation, recovery, deletion, event and consistency implementations indefinitely. The chosen design keeps the historical reader inside the migration boundary and converges to one business store.

**Full offline migration with a faster progress bar.** Batching helps throughput but does not bound time to first new work for arbitrary history sizes. Independent owner preparation makes that delay depend on required global work and recovery-active owners instead.

**Rename every legacy snapshot directory at startup.** Released Git repositories can contain absolute alternates. Renaming their dependencies breaks reads before migration or recovery can materialize the required objects. In-place protection preserves this graph until independently sealed backup segments exist.

**Disable durability or increase every timeout.** Skipping verification or sync weakens recovery; an unbounded timeout hides stalled work. Bounded batches, publication receipts and operation-specific maintenance budgets preserve those checks.

## Consequences

Historical JSON is temporary immutable migration input, not a second application data store. Disk space must cover retained sources, independent backup and canonical data; hard links reduce duplication only on one filesystem. A quarantined owner or external Git dependency may deliberately prevent backup completion or cleanup. Large shared global migrations still block startup conservatively.

The local synthetic benchmark varies transcript bodies tenfold across 1,000 Sessions and reports readiness, foreground p95, import duration and process RSS. It is repeatable with `bun packages/product-runtime/script/benchmark-upgrade.ts`; it does not establish a hardware-independent production SLA. Detailed measurements and limits live in the [research report](../../../research/2026-09-20-storage-upgrade-hardening.md).

The design applies [GitLab's batched migration guidance](https://docs.gitlab.com/development/database/batched_background_migrations/) to resumable owner-local work, [SQLite's WAL rules](https://www.sqlite.org/wal.html) to checkpoint pressure, [SQLite's VACUUM requirements](https://www.sqlite.org/lang_vacuum.html) to optional maintenance, and the [Git repository layout](https://git-scm.com/docs/gitrepository-layout) to alternate-object recovery. The existing [staged upgrade decision](2026-09-19-staged-session-upgrade.md) remains authoritative for in-flight format 3 recovery.
