# Decision Record: Bound repeated execution presentation work

Status: implemented

## Problem

A large task tree rebuilt its execution view by validating every historical journal event for every descendant after each process restart. In the measured workload, journal replay occupied most of the request. Retained usage queries also discovered descendants by decoding every link in the Scope, including for an empty Session.

## Decision

Harness exposes a current presentation snapshot backed by a discardable owner-local checkpoint. Initial construction uses the strict fixed-revision journal fold; later reads validate the retained boundary and fold only newly committed events. The checkpoint records its own format version and is replaced when unsupported or inconsistent. Publication checks the original journal head in a short transaction, without holding a read transaction during replay. Owner deletion removes the checkpoint. This is a new derived read model, not an upgrade to authoritative evidence.

Workbench uses this current view with at most eight owner reads in flight. Checkpoint reconstruction uses background storage priority and yields between journal batches so interactive reads can proceed. Recovery, portable archives and explicit historical snapshots retain full journal validation. Presentation reuse cannot establish the integrity of older evidence, and is never used as an audit receipt.

Usage links atomically maintain an index keyed by parent owner and run. Queries traverse selected descendants and retain the distinction between exact run links and owner-only ancestry. A central usage migration backfills historical links in bounded transactions. Transfer reconciliation maintains the same index and removes replaced ancestry. Retained child usage stays reachable after parent transcript or usage deletion.

The lineage migration explicitly runs at startup against already imported usage links. It does not require historical Session bodies, and imported or rebuilt links maintain the index through the same writer. Declaring that execution stage lets released installations retain deferred history admission. The released completion-ledger integration tests exercise that distinction.

Operation time-index reads apply their exact logical prefix, timestamp bounds and cursor in SQL before returning each bounded page. They reuse the existing ordered index and merge with Session pages in canonical order; they do not enumerate or sort the full operation subtree in JavaScript. Prefix matching compares serialized segments case-sensitively, without treating wildcard characters as patterns. Storage tests cover both page directions, deleted cursors, time bounds and actual early/late query plans. This avoids adding a physical index to every stored record; unrelated operation candidates can still be filtered while seeking the shared ordered index.

Scope Core bootstrap batch-reads only workspaces referenced by the navigation page and current binding. It does not enumerate and decode the complete Scope catalog before filtering it. The response continues to declare an incomplete workspace set.

The composed large-history page also exposed duplicate compaction cards: virtual footer/process segments held all message metadata but no body Parts, so the shared component synthesized running placeholders for already committed summaries. Compaction body ownership now controls which segment emits a card; active or failed attempts without recovery retain one footer card. Completed metadata remains complete before lazy content arrives. DOM tests exercise all three states and opening the summary.

## Alternatives considered

Increasing request timeouts leaves the repeated work and queue contention intact. An in-memory cache loses all benefit on restart. Reading mutable current Rollout records directly would omit journal gaps and require a separate consistency protocol. Suppressing descendant accounting would change the visible result.

## Consequences

The first presentation of previously uncheckpointed evidence still validates that history once. Subsequent process starts reuse the persisted fold, and newly committed events retain their sequence checks. Unsupported checkpoints are rebuildable; authoritative missing evidence still fails strict replay. Tests cover restart, concurrent append, gaps, deletion, historical revision reads, migration idempotence, orphan descendants, exact ancestry and unrelated corrupt lineage.
