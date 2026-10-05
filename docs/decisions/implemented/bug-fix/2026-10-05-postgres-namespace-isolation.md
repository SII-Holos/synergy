# Decision Record: PostgreSQL namespace transaction isolation

Status: implemented

## Problem

Independent PostgreSQL namespaces share physical record and traversal tables. Serializable snapshot isolation tracks predicate dependencies at page and table granularity. Concurrent writes and temporary-node cleanup in eight disjoint namespaces can therefore exhaust all three transaction retries despite each Runtime touching only its own data.

The storage contract already admits one writer per namespace through a dedicated advisory-lock connection. `TransactionalStore` queues its mutations and checks the namespace owner row under a shared row lock inside each transaction. Losing ownership rolls back the operation and requires explicit recovery.

## Decision

Use PostgreSQL `REPEATABLE READ` for writes and retain `REPEATABLE READ READ ONLY` snapshots. Keep namespace ownership, queued writes, row fencing, synchronous commit, bounded SQLSTATE retries and unknown-commit reconciliation intact.

This preserves one consistent transaction snapshot and atomic records, receipts and events without adding physical predicate dependencies between disjoint namespaces. It is not a general replacement for serializable business transactions: cross-namespace transactions and multiple concurrent writers for one namespace remain unsupported. Callers may not bypass `TransactionalStore` with independent raw writes.

## Alternatives considered

Increasing retry counts would retain the contention and add latency. A database-wide writer lock would prevent independent namespaces from progressing concurrently. Separate schemas would require a physical migration; the existing namespace ownership contract makes neither change necessary.

## Consequences

The PostgreSQL contract test opens eight independent stores and overlaps 256 transactions that read and advance their own counter while creating and removing temporary traversal nodes. All writes must commit, each owner must retain its exact counter, and removed nodes must be absent. The existing rollback, snapshot, command-receipt and ownership-loss contracts continue to apply on PostgreSQL 16, 17 and 18. No schema or data migration is required.

## References

- [Agent storage](../../../architecture/agent-storage.md)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL ownership tests](../../../../packages/harness/test/storage/postgres-ownership.test.ts)
- [PostgreSQL contract tests](../../../../packages/harness/test/storage/postgres-contract.test.ts)
