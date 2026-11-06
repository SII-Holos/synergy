# Decision Record: Bound artifact subtree work by the selected keys

Status: implemented

## Problem

A small message-content cleanup can share an artifact owner with a long Session history. Filtering that owner's rows with an exact-key-or-`LIKE` predicate makes both collection-intent insertion and reference deletion scan unrelated history while holding the writer transaction. The same predicate affects paginated enumeration and retention budget checks. SQLite's default `LIKE` also folds ASCII case, which can select descendants from a different logical segment.

## Decision

Centralize artifact subtree selection in `StoreTransaction`. SQLite uses the existing binary `(namespace, key_text)` primary key. For a nonempty canonical JSON string-array prefix, replace its closing `]` with `,` to obtain the inclusive lower bound; the complete prefix is the inclusive upper bound. At that position a valid canonical key can continue only with a comma for descendants or a closing bracket for the exact key. The interval therefore includes precisely those keys, including escaped strings and Unicode, without an owner-wide residual filter.

Pagination substitutes its last returned key as the exclusive lower bound. Retention probes apply their limit directly to the indexed range, without first materializing the subtree. Namespace-root operations remain explicitly namespace-wide. PostgreSQL keeps its case-sensitive prefix matching because its collation need not order JSON punctuation like SQLite; partial-owner prefixes do not apply a nonexistent owner filter. No persisted schema, extra index, migration or startup rebuild is required.

Keep artifact reference deletion and deduplicated collection intents inside the existing transaction. Preserve mutation admission, namespace isolation, record tombstones, physical-prune cancellation and shared-pack liveness. The owning invariants are documented in [Agent storage](../../../architecture/agent-storage.md).

## Alternatives considered

**Add an artifact prefix index or change key encoding.** This adds storage and write amplification plus a large historical rebuild, although the existing primary key already contains the required ordering.

**Materialize exact-key and descendant queries before deletion.** Separate seeks are valid, but canonical JSON keys allow one interval. Unbounded materialization would also defeat early pagination and retention probes unless every limit and cursor were pushed inside it.

**Move cleanup out of the transaction or increase query deadlines.** Deferred reference changes would separate business state from collection intent, while longer deadlines preserve the writer-queue stall.

## Consequences

SQLite work is proportional to the selected artifact range, with indexed seeks for missing subtrees and bounded early and late pages. Deleting a genuinely large selected subtree remains proportional to its size. PostgreSQL receives matching correctness and budget semantics without a new performance claim for its existing prefix plan.

Real SQLite format 2/3 tests inspect plans with thousands of unrelated references in the same owner, cover empty and small deletions, page across multiple boundaries and stop budget probes after the first excess reference. Shared SQLite/PostgreSQL tests cover exact roots, partial owners, case variants, escaped punctuation, Unicode, namespace separation, shared packs, collection-intent deduplication and rollback. Existing pruning and streaming-persistence suites exercise cancellation and business callers. Performance gates assert query work and behavior rather than host-dependent elapsed times.
