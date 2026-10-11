# Decision Record: Batch Session transfer reads without caching authority

Status: implemented

## Problem

Transfer presentation adds a durable read to every Session enrichment, and transfer mutation admission reads both destination reservations and source gates for each write. The existing 1300-child listing fixture magnifies these round trips despite bounded enrichment concurrency. Its Workspace preparation and original 30-second timeout are retained; the earlier [Workspace hydration decision](2026-09-25-batch-session-workspace-hydration.md) does not batch transfer records.

Pass-through SQLite worker and transaction observations on an identical fixture show 7804 additional SQL requests between the baseline and transfer-enabled implementation across seed, rebuild and two listings. Of these, 5202 are reservation/gate reads and 2600 are transfer presentation reads. Both local samples pass; their elapsed times do not establish the CI timeout's stage or unique cause.

## Decision

List, search and child-list enrichment reads `session_transfer_out` through one `Storage.readMany` call for the requested Sessions. Storage owns the 128-key statement chunks and snapshot transaction. A call-local map associates missing or present transfer records with their Session identities while the existing 32-worker enrichment retains ordering, hydration and control-profile resolution. Single-Session enrichment retains its independent durable read after working/history resolution. Every record still uses `SessionTransferState.parse`; cancelled transfers remain absent from client output and persisted Session metadata excludes the projection.

Non-broad mutation admission reads each owner's reservation and gate together through the current `StoreTransaction.readMany`. Positional splitting preserves missing records, owner attribution and reservation precedence. Every mutation performs the read again, including after a previous write in the same transaction installs a fence. Broad subtree operations retain their existing namespace queries. Runtime-bound activation, trusted migration admission, synchronous commit guards, retries and rollback keep their existing owners and checks.

The work-bound regression extends the real temporary-Scope fixture without changing its size, timeout or original listing assertions. A pass-through counter requires one transfer batch admission per listing. A separate real-storage regression requires one fence batch per mutation, rejects a same-transaction newly installed gate, preserves rollback and rejects a destination reservation. Mixed transfer/missing records, phase changes, cancelled state and malformed records cover presentation without retaining authority across calls. Existing paused transfer, broad deletion, commit-guard and transaction-context scenarios remain intact.

The two transfer batch contracts live in a dedicated SQLite/PostgreSQL parameterized file registered in the real PostgreSQL matrix. `testRuntime` receives its PostgreSQL URL explicitly; merely setting the test environment does not switch its default SQLite backend. The existing 1300-Session work-bound fixture remains in its ordinary records suite, avoiding duplication of that stress preparation in each database matrix job.

## Alternatives considered

**Raise the timeout, retry the test or enlarge storage admission.** These do not reduce the measured round trips and can conceal continued amplification.

**Cache transfer presentation or fence absence across calls or mutations.** A later transfer, reservation or gate must be observed through durable storage. A transaction-wide absence cache could admit a write after an earlier write installs a gate.

**Only reduce enrichment concurrency.** The existing 32-worker bound already limits simultaneous admission; reducing it retains all 2600 presentation round trips.

## Consequences

Measured SQL requests across the four comparable phases fall from 101196 to 96021, a reduction of 5175. Seed changes from 11252 to 9952, rebuild from 7854 to 6553, and the two listings from 61217/20873 to 59930/19586. Each 1300-Session presentation batch uses 11 statements plus snapshot BEGIN/COMMIT instead of 1300 point-read statements. Fence authority is still queried on every mutation rather than skipped.

The change adds call-local memory proportional to the selected Sessions and a shared transfer read snapshot; it does not make an unpaginated list bounded in total size or make working/history data share that snapshot. No persisted schema, API, queue limit, deadline, admission permission or storage-driver behavior changes. Local work reduction is established, not a host-independent latency guarantee or proof that the CI timeout is reproduced. Real PostgreSQL engine and full CI acceptance remain separate from SQLite and PostgreSQL transport-fixture evidence.
