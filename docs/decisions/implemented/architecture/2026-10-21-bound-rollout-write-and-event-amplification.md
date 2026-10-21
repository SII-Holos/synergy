# Decision Record: Bound Rollout write and event amplification

Status: implemented

## Problem

Concurrent provider streams amplify database work through repeated attempt metadata, archive checkpoints and outbox acknowledgments. Projected clients can receive one cursor per omitted event, spending network and renderer work on evidence they do not display.

## Decision

Separate transport durability, journal representation and frontend projection within their existing owners. Archive the first response block immediately and later blocks at 100 ms or 256 KiB, preserving durability before delivery and original network timing. Capture Rollout journal events transactionally without a generic outbox entry that has no delivery effect; acknowledge successful ordinary notifications together after their business commit.

Store immutable attempt context once per owner and hash, with complete dynamic state on every journal event. Replay expands both legacy and context-v2 storage into the existing full event schema. No-op attempt updates skip journal publication only when no artifact publication is pending. Corrupt context remains an integrity failure.

Historical conversion is an explicit central maintenance migration with an exclusive lock, consistent backup, checksum, cancellation and resumable batches. It preserves logical evidence, revisions and retention age. SQLite backup fences database work, requires a complete WAL checkpoint and copies the immutable file without rebuilding its indexes; final publication follows file sync and checksum. Existing owner pruning and offline reclamation retain physical cleanup ownership.

The backup fence follows [SQLite's file-copy consistency constraint](https://www.sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active); `SqliteDriver.backup` carries the provenance marker and keeps ownership plus all reader/writer queues held until copying finishes.

Projection-v2 omits LSP diagnostics and coalesces contiguous omitted-event cursors by Scope and epoch for 50 ms, bounded to 128 Scopes. Visible events flush their preceding cursor; gaps remain gaps. Asynchronous sends obey the ordinary streaming eviction policy, and disconnection releases pending work.

## Alternatives considered

Delivering bytes before archival acknowledgment would reduce latency by weakening recoverability. Periodic full snapshots with dependent deltas would reduce metadata but make replay depend on an unbounded chain. Automatic historical compression at startup would put maintenance on interactive readiness. An additional online pack collector would duplicate existing deletion ownership. These approaches were rejected.

## Consequences

Later response text can wait up to the batching window before archival begins; the first response block does not wait for it. Dynamic state remains directly recoverable from one event and its immutable context. Public event and archive schemas remain unchanged, while older readers require a pre-change backup for downgrade.

Small deterministic fixtures cover durability, cancellation, failed acknowledgments, cursor ranges, mixed histories and interrupted conversion. The maintenance contract also runs in the existing Windows, macOS and PostgreSQL selections. Long streams and copied-data diagnostics remain explicit local acceptance, with no production dataset or machine-specific latency threshold in CI. Counter metrics aggregate per second so instrumentation does not reproduce the write amplification it measures.

Canonical behavior lives in [Agent storage](../../../architecture/agent-storage.md), [LLM loop](../../../architecture/llm-loop.md) and [frontend synchronization](../../../architecture/frontend-data-sync.md).
