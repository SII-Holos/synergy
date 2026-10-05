# Decision Record: Materialize node cleanup candidates

Status: implemented

## Problem

PostgreSQL can estimate that a newly created namespace contains one traversal node even when it already has hundreds. An inlined cleanup candidate query can then run again for every outer deletion row, multiplying recursive and anti-join work during ordinary record removal. See the [investigation](../../../postmortem/0048-postgres-node-cleanup-repeated-candidates.md).

## Decision

Each bounded cleanup iteration materializes its candidate set inside the existing SQL statement. The next iteration still recomputes candidates after deleting leaves, preserving fixed-point cleanup, shared ancestors, revision tombstones and transaction rollback. Both supported engines execute the same query; persisted formats and public APIs do not change.

## Alternatives considered

**Rely on fresh statistics.** New namespaces can be admitted between automatic analysis passes. Correct latency must not depend on a database-wide statistics refresh before every conversation.

**Disable PostgreSQL JIT.** The reproduced slow plan had no JIT compilation, and the isolated setting change did not improve it.

**Increase test and request deadlines.** Longer deadlines conceal repeated work and leave ordinary invocations slow as shared storage grows.

## Consequences

One bounded candidate set uses statement-local memory before deletion. A real PostgreSQL regression records actual execution-plan work with stale namespace statistics, alongside deletion and namespace-isolation assertions. Existing SQLite format 2/3 tests retain rollback and delayed-write coverage.
