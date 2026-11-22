# Decision Record: Bound PostgreSQL node cleanup by addressed keys

Status: implemented

## Problem

PostgreSQL can overestimate the output of the recursive subtree query. Joining that estimate to the node table makes even an empty final cleanup pass visit unrelated nodes while the transaction holds the store's serial write queue.

## Decision

Discover descendants with a parameterized parent lookup. Give the planner concrete keys for each leaf deletion and recheck both live records and children in the deleting statement. Keep small subtrees in one batch. For larger subtrees, use a transaction-local scrollable cursor and revisit pages and explicit ancestors until no further leaves disappear. A pending prune cancellation aborts at batch boundaries.

## Alternatives considered

A materialized candidate and a final row limit still allow a namespace-wide scan before the limit. Changing database-wide planner settings affects unrelated queries. Committing intermediate deletions would change rollback and parent visibility.

## Consequences

The existing transaction covers record updates, traversal nodes and ancestor reclamation. Clients receive at most 128 keys per cursor fetch or deletion. PostgreSQL can use temporary storage for an addressed subtree that exceeds working memory. Large prunes still occupy the serial writer until the transaction finishes or rolls back. SQLite retains its indexed recursive cleanup. Regression tests measure actual rows visited and cover an empty final pass, wide subtrees and rollback.
