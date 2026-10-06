# PostgreSQL node cleanup repeated candidate work

## Executive summary

Ordinary PostgreSQL conversation tests sometimes exceeded their unchanged deadline after earlier namespaces populated the same database. The planner repeatedly evaluated an inlined node-cleanup candidate query. Empty-database checks concealed the cost; real plans under stale per-namespace statistics exposed it.

## Summary

A three-turn fixture took about five seconds in a fresh database and about twenty-five seconds in a later namespace. Storage opening and closing remained short. SQL instrumentation attributed most of the extra time to derived-node cleanup during record deletion.

## Timeline

- 2026-10-05: repeated the same installed runtime against fresh and populated PostgreSQL fixtures.
- Separated lifecycle and conversation timings, then inspected the emitted cleanup statement and its real plan.
- Reproduced more than sixteen million node visits while removing forty records from a namespace with 644 nodes.
- Materialized cleanup candidates and repeated the unchanged three-turn fixture successfully at about five to six seconds.

## Root cause

Statistics collected before a namespace was created estimated one matching row. PostgreSQL inlined the candidate CTE under a nested deletion loop, repeating its recursive traversal and anti-joins for outer rows. Indexed predicates did not bound the repeated work. JIT was absent from the slow plan.

## Guardrails added

- [Implementation decision](../decisions/implemented/bug-fix/2026-10-05-materialize-node-cleanup-candidates.md).
- `packages/harness/test/storage/postgres-node-cleanup.test.ts` captures the actual statement with EXPLAIN ANALYZE inside a rolled-back savepoint and bounds row visits without a wall-clock assertion. It also verifies retained siblings, foreign namespaces and storage integrity.
- The PostgreSQL 16–18 selection includes this regression; the persistence skill requires stale-namespace planning evidence for deletion changes.

## Lessons

An intermittent CI timeout can expose data-dependent query complexity. Diagnose actual database work before increasing deadlines or treating a passing retry as an explanation.
