# Decision Record: Batch Session Workspace hydration

Status: implemented

## Problem

Scope startup recovers workflow timers by enumerating Sessions. Hydrating each Session's Workspace with an independent concurrent read makes storage admission proportional to the number of historical Sessions. A large Scope can exhaust the shared reader queue and prevent both startup and unrelated foreground requests from reading state.

## Decision

`SessionRecords.readMany` deduplicates Workspace IDs and resolves them through `WorkspaceCatalog.readMany`. Storage executes the batch in bounded SQL statements under one reader admission. Session projection checks the Workspace's Scope, preserves missing Session positions and unresolved references, and retains schema failures as errors. The batch has no cache beyond the current call, preserving subsequent rebinding visibility. Single-record hydration keeps transaction-local reads.

The regression fixture lists more Sessions and distinct Workspaces than the reader queue can admit individually, including shared Workspace references. Additional assertions cover ordering, absent records, foreign Scope references, null and legacy selections, malformed catalog records and rebinding.

## Alternatives considered

**Increase the reader queue limit.** This postpones the same failure until a larger history is loaded and consumes more admission capacity without reducing redundant work.

**Limit concurrent per-Session reads.** This bounds admission but retains one database round trip for every Session, including repeated references. The existing storage batch reader already supplies bounded statements and snapshot consistency.

**Cache Workspace projections across calls.** This requires invalidation on rebinding and retirement and risks stale authority. Deduplicating within the current call avoids that lifecycle.

## Consequences

Large Session reads use admission independently of their Session count without changing persisted formats, queue limits or HTTP schemas. Workspace metadata for one batch shares a read snapshot. Memory remains proportional to the requested batch; this change does not make full Session enumeration paginated.
