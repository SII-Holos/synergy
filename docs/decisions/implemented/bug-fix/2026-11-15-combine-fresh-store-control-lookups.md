# Decision Record: Combine fresh Store control lookups

Status: implemented

## Problem

Native mutation guards separately query a maintenance point and orphan history. Single Session writes separately read parent deletion and target revision, transferring bodies those checks do not need. Combining observations must preserve canonical identity, publication admission and changes across the original awaited checks. Derived nodes cannot replace a point, and an earlier revision cannot authorize a later mutation.

## Decision

The Store owns both combinations through its existing connection, namespace encoding and transaction. No schema, driver protocol, migration, mutation guard or capacity deadline changes. [Agent storage](../../../architecture/agent-storage.md#records-and-transactions) defines the current reader and writer behavior.

`StoreTransaction.readWithPrefixWitness` independently admits the point with ordinary semantics and the prefix with tree semantics before querying. Both declared selectors must be published even when the point exists. This is the new primitive's stricter contract; existing `queryKeys` and `list` filtering is unchanged. Maintenance's non-Session selectors add no admission SQL.

The point lookup is independent of derived nodes. SQL CASE evaluates the original prefix query only for a SQL-NULL point body. Non-null bodies use the canonical codec and owning schema; absent points interpret the original prefix witness. Existing current pointers retain the dependent operation/retirement read. Unsupported non-null codec values fail closed. Native preparation errors remain native errors without a promised historical ordering for arbitrary physical schema damage.

Single Session writes select only parent/target identity, revision and deletion metadata. Mutation guards run first; parent deletion still precedes the original later publication check, target collision and compare-and-swap. A numeric per-transaction query serial covers every dispatch through the original wrapper, including cached raw aliases. Operation-local reuse requires an unchanged selector and exactly the metadata query plus its counted admission queries. Other queries, including reads, or a changed selector cause a fresh thin target read at the original later row phase. Bodies and authority are not cached across calls. Node insertion, encoding, record mutation and outer COMMIT retain their order.

## Alternatives considered

**Prefix-first selection.** A valid point remains authoritative when derived nodes are missing. Prefix order and projected kinds cannot replace canonical identity and codec validation.

**Cached maintenance or owner authority.** Same-transaction changes and rollback require fresh checks; earlier observations cannot authorize later mutations.

**Unconditional target reuse across admission.** Typed work or an already captured raw-query alias can change the target during that await. A write-only counter misses those paths; the complete query serial conservatively requires rereading.

**A driver operation or persisted index.** Existing SQL and Store ownership express both combinations without a new protocol or migration obligation.

## Consequences

Idle maintenance checks use one statement; existing points skip prefix traversal and sorting. Single writes avoid a metadata request and large bodies when no intervening query requires rereading. Concurrent activity keeps the original fresh target read. This does not make arbitrary parallel same-key writes linearizable or close the existing later compare-and-swap window.

The [incident](../../../postmortem/0216-native-control-lookups-repeated-sql-dispatches.md) separates actual owner work-count improvements from full capacity acceptance. Real-record tests retain canonical corruption, publication, error priority, typed/raw interleaving and rollback controls. PostgreSQL 17.11 contracts pass 43 cases and 565 assertions, with two explicit SQLite-only skips. The complete unchanged capacity result remains pending; fewer dispatches alone do not establish it.
