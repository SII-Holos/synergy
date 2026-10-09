# Decision Record: Complete empty migration inputs in one transaction

Status: implemented

## Problem

An on-demand Runtime with no historical records still performs a transaction for every registered historical transform. PostgreSQL startup diagnostics identify these repeated completion writes and input probes as a substantial part of initialization. The absence of a Session does not imply that configuration, filesystem or global maintenance work can be skipped.

## Decision

Owners can declare `emptyInput` record prefixes only when no body effects exist without those records. The runner checks all declared prefixes and completes consecutive eligible migrations in one ownership-fenced transaction. It reuses an empty-input observation only inside that transaction, ends the group before an ordinary migration, and preserves dependency order. On-access registrations can share the group because their actual transformations retain per-Session receipts.

Historical import activity and existing cohorts prevent an empty-input completion. External effects stay outside retryable database callbacks. Commit failure publishes none of the group's completion markers. Configuration, schema, filesystem and snapshot ownership migrations retain their existing execution paths.

Navigation transforms include both Session records and navigation records in their input declaration. Building an absent, empty index is a no-op; an existing stale index is still replaced. Schema-only and superseded Session transforms keep their migration IDs and can share empty completion. PostgreSQL and SQLite run the same owner-body and atomic-completion tests.

The legacy Scope rename first enumerates immediate record roots. When every consumed root is absent, it avoids empty authority mutations but still moves filesystem snapshots and invokes the optional library owner. Home-only references and cached statistics remain inputs, and a discovery failure cannot prove absence. Orphan reclamation does not inspect project directories when no candidate Scope remains.

Record-only rollout, usage lineage, retired Link and unfinished checkpoint transforms now declare all of their input roots. Rollout includes stale statistics even when no Session exists; Link retirement includes permission rules. Persistent-volume identity discovery happens only when Workspace records exist. Existing nonempty-data tests and empty-body equivalence tests cover these declarations on both database backends.

## Alternatives considered

**Assume a new SQL namespace is current.** A newly opened namespace may still have historical imports or external files. Blanket completion would omit required work.

**Defer every completion write until startup finishes.** A crash could replay previously completed external effects. Grouping only proven no-ops avoids extending that replay boundary.

**Keep one transaction per no-op.** This preserves behavior but spends database round trips on absent inputs. The declarations and transactional proof preserve the same outcome with less startup work.

## Consequences

Owners must keep declarations aligned with every input a migration reads. Tests exercise the actual declared bodies on empty authority, nonempty nested input, changes introduced between groups, historical cohorts, dependency selection, and atomic rollback. This optimization does not change old-data transformations or authorize a Runtime to bypass storage recovery, and measured product startup remains a separate acceptance requirement.
