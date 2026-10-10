# Decision Record: Display preparation follows transaction ownership

Status: implemented

## Problem

Foreground display preparation can run inside a caller-owned storage transaction or outside one. Sharing a preparation promise across those callers can make a writer wait on work queued behind itself, or let an external caller report success from a projection that its owner later rolls back. Canonical messages and their projection predecessors can also change while preparation waits for writer admission. An unconditional writer transaction for already prepared Part pages makes committed reads contend with unrelated mutations.

This record supplements the server batching in [visible-first session loading](../feature/2026-10-09-visible-first-session-loading.md) with transaction ownership and canonical publication authority. The current invariants live in [Sessions and messages](../../../architecture/session-and-messages.md#presentation-and-full-history-operations).

## Decision

[SessionHistoryDisplay](../../../../packages/harness/src/session/history-display.ts) separates transaction-owned window preparation from external coalescing. `prepareWindow()` inside an ambient transaction prepares its own wave directly and does not join or publish the shared drain. Calls outside a transaction share a Storage-scoped, per-Scope/per-Session drain containing message IDs rather than caller-captured message records. Their preparation writes settle through their own transactions before the drain resolves; an ambient caller's return remains subject to its owner's commit or rollback.

Window waves process at most 64 message IDs per batch. External preparation first compares canonical message infos and existing display headers in a read-only snapshot. An unchanged batch skips writer admission. A changed batch rereads both canonical infos and projection predecessors after writer admission before publishing headers or removing obsolete message, timeline and root entries. Caller-provided infos supply identities, not publication authority.

Reread records pass through `MessageV2.canonicalMessage()` before display summarization. In particular, an expired pending file-change settlement remains a timeout projection rather than reverting to pending; normalization changes the read projection, not the stored canonical record.

`partPages()` checks readiness and collects every warm page in one `Storage.snapshot()`, without writer admission for Part materialization. If any page is cold, an external caller releases that snapshot before entering one writer transaction and collects the batch sequentially there. Each message rereads preparation state and canonical Parts under that writer, retaining its generation guard. Nested writes join the ambient writer, so failure rolls back the complete cold batch. A caller-owned read-only snapshot cannot be upgraded to a writer for cold preparation.

## Alternatives considered

**Share the same drain with ambient transactions.** Rejected because transaction-local visibility and rollback belong to the caller, while external waiters need committed preparation. The shared promise cannot establish both guarantees and can introduce a writer waiting on its own queued work.

**Publish caller-captured headers after writer admission.** Rejected because waiting permits canonical chronology, root classification and message existence to change. Rechecking canonical records and projection predecessors prevents stale headers and obsolete index entries from being republished.

**Wrap every Part batch in a writer transaction.** Rejected because ready pages require only a consistent committed read. A readiness probe alone is insufficient: the pages must be collected in the same snapshot to avoid mixing publications.

## Consequences

Transaction-owned preparation preserves read-your-writes and rollback without enrolling external callers in uncommitted work. External drains remain coalesced and isolated by Storage instance and owner identity. Warm Part batches avoid the writer queue; cold Part materialization retains one atomic writer transaction for the batch.

Changed window batches pay for a read-only comparison and a second comparison under the writer. Cold Part batches remain serialized, and read-only callers must leave their snapshot before requesting materialization. These costs preserve canonical publication authority rather than trading correctness for fewer reads.

## Verification

The [display transaction isolation tests](../../../../packages/harness/test/session/display-transaction-isolation.test.ts) cover held-writer admission, ambient rollback versus external completion, canonical rechecks, warm committed reads, one-snapshot page consistency, cold read-only rejection, atomic cold-batch rollback and retry, and independent Runtime registries. Parent-agent evidence reports the focused SQLite run green with 19 tests and 120 assertions; this documentation task does not independently rerun that evidence.

The public [display-page tests](../../../../packages/harness/test/session/display-page.test.ts) additionally verify expired and unexpired pending settlements, preservation of an existing timeout projection through external and ambient preparation, and unchanged stored evidence. The regression failed with a pending projection before the normalization fix and passed afterward.

The test is registered in [POSTGRES_TEST_FILES](../../../../packages/harness/test/support/storage-backends.ts), consumed by the [CI catalog](../../../../script/ci/catalog.ts) for PostgreSQL 16, 17 and 18. Focused transaction-isolation execution passed on each of those versions with 8 tests and 32 assertions; the separate display-page suite remains SQLite evidence, not PostgreSQL coverage. Registration and execution evidence do not establish the full backend matrix.
