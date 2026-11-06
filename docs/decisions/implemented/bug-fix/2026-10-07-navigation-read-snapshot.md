# Decision Record: Read existing navigation indexes in a committed snapshot

Status: implemented

## Problem

A navigation read entered the business writer queue even when its derived index already existed. An unrelated held writer therefore delayed `readNavIndex()` and `queryScope()` instead of allowing them to return committed navigation state. The independent reader and writer lanes established by the [interactive storage decision](2026-09-22-interactive-storage-and-input-recovery.md) could not provide isolation while the domain operation selected writer admission unconditionally.

Deferred Session listings also compose an index with a paginated catalog. A direct store query inside a domain reader snapshot starts another reader admission rather than joining the parent, risking self-blocking on the serialized reader lane. Inside a business transaction, the same direct query misses uncommitted catalog changes.

## Decision

`SessionNav.readNavIndex()` reads an existing index and its deferred catalog merge inside one `Storage.snapshot()`. If the index is absent, it exits that snapshot before entering `Storage.transaction()`, where the existing lazy reader rechecks the index before building. Concurrent cold requests consequently share the first committed build without adding a cache or single-flight coordinator.

`SessionCompat.pendingInfos()` passes the active Storage transaction to `StorageCompat.catalog()` when one exists; the catalog accepts the existing query interface and retains its pagination. Navigation called inside a business transaction therefore observes its own index and catalog writes. An enclosing readonly snapshot remains readonly and cannot be promoted for a cold build. Existing missing-index and lazy-build error handling is not broadened.

Canonical publication filtering, deferred deduplication, ordering, Scope/global filters, tags and cursors remain owned by their existing code. This change does not modify record formats, schema, migrations, drivers, other navigation query semantics or index mutation granularity.

## Alternatives considered

**Keep all navigation reads in the writer transaction.** This provides a consistent merge but makes an existing derived-index read wait for unrelated mutations, defeating committed-reader isolation.

**Build the missing index inside the reader snapshot.** Readonly transactions cannot write, and releasing an outer caller's snapshot would break its consistency. Cold top-level reads instead release only their own snapshot and recheck after writer admission.

**Read the index and catalog in separate snapshots.** This can combine different publication states and misses transaction-local catalog changes. Reusing the parent query interface keeps the merge consistent without changing the catalog algorithm.

## Consequences

Steady navigation reads no longer contend for writer admission; cold construction still serializes with mutations. The derived index and deferred projection share one reader or writer view, while catalog entries remain absent from the persisted canonical index. The change does not reduce whole-index write amplification or establish a latency guarantee.

Real temporary Runtime/SQLite regressions first reproduce held-writer blocking and stale writer-local catalog projection, then verify committed reads before writer release, read-your-writes, two cold readers queued behind one writer, admission-time recheck, fixed reader snapshots across a concurrent catalog commit, canonical visibility and unchanged merge filtering. Rescue deadlines and cleanup bound failing tests; completion order, not machine speed, determines isolation. Existing navigation and compatibility suites retain query and upgrade coverage. PostgreSQL behavior follows the same Storage transaction composition and remains subject to its existing CI contract matrix.
