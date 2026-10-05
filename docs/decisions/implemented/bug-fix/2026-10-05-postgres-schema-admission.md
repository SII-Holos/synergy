# Decision Record: PostgreSQL shared schema admission

Status: implemented

## Problem

Each PostgreSQL namespace shares the physical storage tables. Executing `CREATE INDEX IF NOT EXISTS` during every namespace open still takes locks that conflict with active record writes. Trigger replacement also locks its target table. Namespace admission must not repeatedly lock an already initialized shared schema.

## Decision

Inspect the bootstrap objects through PostgreSQL catalogs before namespace admission. If all tables, indexes, functions and triggers exist, issue no DDL. Otherwise take a database-scoped transaction advisory lock, recheck the catalog and create only missing objects in dependency order. Use `READ COMMITTED` for this schema transaction so a waiter sees the preceding initializer's committed objects. Namespace data transactions keep their existing isolation and ownership fences.

The catalog reader accepts only the DDL forms owned by `TransactionalStore`; an unknown form fails explicitly. Bootstrap creates missing physical objects. Changes to existing definitions require an explicit owning migration instead of implicit replacement on every open. No additional schema ledger, namespace layout or data-format change is introduced.

## Alternatives considered

More retries retain repeated locks and latency. Serializing all namespace writes would remove useful concurrency. A process-local initialized flag would miss independent Hosts and schema changes. A durable schema fingerprint would add a separate version ledger when existence checks suffice for the current bootstrap definitions.

## Consequences

Existing databases pay one catalog read per writable open. Missing-object initialization is serialized, atomic and retryable; a failed initializer releases its lock and leaves no partial objects. Read-only opens do not initialize anything. SQLite retains its current schema path. Existing-object upgrades must be declared deliberately through migrations.

## References

- [Agent storage](../../../architecture/agent-storage.md)
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html)
- [Open/write concurrency regression](../../../../packages/harness/test/storage/postgres-contract.test.ts)
- [Schema initialization contracts](../../../../packages/harness/test/storage/postgres-schema.test.ts)
