# PostgreSQL startup DDL blocked independent writers

## Executive summary

Concurrent namespace opens repeatedly ran shared index and trigger DDL, which could deadlock record writes in other namespaces. Tests opened all stores before writing, so they missed the overlap. Admission must inspect existing schema objects without recreating them, and concurrency tests must overlap startup with an explicitly held write transaction.

## Summary

PostgreSQL reported a cycle between a record writer requesting a node-table write lock and namespace startup requesting an index-build lock on records. `IF NOT EXISTS` did not remove the conflicting table lock. A deterministic open/write regression failed at the configured lock deadline.

## Timeline

The concurrent local campaign exposed deadlocks after independent namespace transaction isolation had been corrected. The PostgreSQL wait graph identified startup DDL. A held-write test reproduced the block. Extending it through startup index maintenance exposed a second invocation of the same DDL.

## Root cause

Physical schema is shared across namespaces, but initialization was placed inside each namespace's admission transaction. The owner-index migration also repeated its creation statement. Existing tests proved idempotent results and concurrent steady-state writes, not lock behavior during startup.

## Guardrails added

The [schema admission decision](../decisions/implemented/bug-fix/2026-10-05-postgres-schema-admission.md) defines the catalog check and serialized missing-object transaction. [Open and migration tests](../../packages/harness/test/storage/postgres-contract.test.ts) hold an unrelated write until both operations return. [Schema tests](../../packages/harness/test/storage/postgres-schema.test.ts) verify concurrent fresh initialization, missing-index/function/trigger repair, preserved records and atomic rollback with subsequent recovery. Both suites run in the PostgreSQL CI matrix.

## Lessons

An idempotent SQL result does not imply lock-free execution. Shared physical initialization must be verified while logical owners are already writing.
