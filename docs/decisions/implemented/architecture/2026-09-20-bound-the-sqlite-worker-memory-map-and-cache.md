# Decision Record: Bound the SQLite worker's memory map, page cache, and statistics refresh

Status: implemented

## Problem

The authoritative SQLite worker opened both of its connections on engine defaults chosen for a database far smaller than this one. `mmap_size` was `0`, so every read went through the page cache and `pread` instead of a memory map, and `cache_size` was SQLite's default `-2000` — a 2 MB page cache — against a store that has measured 32 GB. The worker ran no statistics maintenance either, so a production database carried no `sqlite_stat1` at all; every plan the planner produced for the store's scope/session/kind reads was costed from built-in guesses.

That last fact was load-bearing during the owner-enumeration investigation: with no statistics, the planner answered from the `kind`-led index and grouped through a temporary b-tree, and the only way to tell whether a different index shape would be chosen was to measure rather than to reason. Statistics do not remove the need for the right index, but their absence made every index decision uninspectable.

The pragmas that fix this are also the ones whose failure is silent, which is the constraint that shapes the decision. `PRAGMA mmap_size = N` does not throw when it cannot honour `N`: it clamps against the compile-time `SQLITE_MAX_MMAP_SIZE`, and it is ignored entirely where memory-mapped I/O is unsupported. An unknown pragma is ignored rather than rejected. A bare `PRAGMA name = value` followed by no error is therefore not evidence that anything changed.

## Decision

**Both worker connections ask for a 256 MiB memory map and a 64 MiB page cache, read each value back, and report the ones the engine did not honour. Windows is left unmapped. Opening also refreshes statistics with a bounded `PRAGMA optimize`.**

`cache_size` is set to `-65536`, a negative byte form, so the cache keeps its byte size if the page size ever changes; the positive form would silently mean a page count. It applies to the reader as well as the writer, because the page cache is per connection and the reader is the connection serving ordinary reads.

`mmap_size` is set to `268435456` on both connections, and is **not requested at all on Windows**. Windows cannot truncate a memory-mapped file, so a mapping would pin the file's size and silently defeat the incremental auto-vacuum that governs this store's capacity. This is a platform exclusion rather than a probe: the platform either supports the operation safely or it does not.

Every value is read back through the same connection that set it. `cache_size` has no compile-time cap, so any value other than the request means the pragma never applied and is reported. `mmap_size` is clamped legitimately, so only a returned `0` — memory-mapped I/O unavailable on this host — is reported. A rejected or clamped pragma writes one redacted line to stderr and never throws or fails startup: the store must open on a host whose engine cannot do this.

`PRAGMA optimize` runs at open on the writer, inside the writable branch, after the pragmas that must precede it. It uses the **default** optimization mask.

The plan is bounded by the mask's `0x10` bit, which caps each `ANALYZE` with a temporary `analysis_limit` so it samples an index that lacks statistics instead of walking it. The unbounded variant is measured and rejected below.

Statistics materialize on the second open rather than the first, and that is accepted rather than worked around: the driver opens the connection before the schema DDL runs, so a first-ever open finds nothing to analyze. Forcing statistics into the first open would require running `ANALYZE` after DDL on every open, which is the cost this decision exists to avoid.

## Alternatives considered

**Request the documented first-open mask, `PRAGMA optimize=0x10002`.** SQLite documents this mask for a connection that will be long-lived, which is exactly this connection, so it was the first implementation. Measurement refuted it: bit `0x10002` _clears_ `0x10`, and the SQLite source sets `nLimit = 0` when `0x10` is absent, which is an **unbounded** `ANALYZE` over every index. On a warm 6M-row, 4-index store the two masks measured 814-850 ms against 73 ms, and the unbounded run analyzed 545,455 index rows against 2,001. The documented advice is for a connection that runs one statement and then serves queries, not for a worker whose open path must complete inside the driver's request deadline on a 32 GB store.

**Set `mmap_size` on Windows as well.** Simpler, and the read-back would report the clamp. It is rejected because the failure is not a clamp but a semantics change: a mapping that cannot be truncated keeps pages that `incremental_vacuum` freed, so the store would stop converging on its byte budget — the exact control loop the retention work fixed. A platform that cannot honour the operation does not get the request.

**Skip the read-back and trust the request.** This is what the code would look like if written from the pragma documentation alone, and it is the shape that hides a misconfiguration indefinitely: `mmap_size` on a clamped host reports no error, so the only symptom is a performance difference nobody attributes to the pragma. The read-back costs one query per pragma at open and converts an invisible mismatch into one stderr line.

**Run `ANALYZE` unconditionally at open.** It produces statistics nearest to the current data distribution. It also walks every index of a 32 GB store on every open, inside the deadline that gates terminal store failure.

**Do nothing, on the grounds that statistics were not the enumeration bottleneck.** Measured, that is true — the enumeration's cost was the unindexed `key_text` selection, not the missing statistics, and the fix that mattered was the index. It is rejected because the absence of statistics is what made the planner's choice unverifiable during that investigation, and because the size pragmas are independent of it. The two changes are complementary: one bounds the statement, the other makes the planner's reasoning inspectable.

## Consequences

The store's read path now maps 256 MiB and caches 64 MiB on each connection, which is a fixed memory cost the worker holds for its lifetime, paid in exchange for not driving every read through a 2 MB cache. `mmap_size` and `cache_size` are per connection, so a test that opens its own `Database` cannot observe them; the assertions go through the driver's writer and reader.

`PRAGMA optimize` runs inside the open path's request deadline and is not free on a store that has no statistics: measured 13 ms at 1M rows, 279 ms at 3M, 1,684 ms at a cold 6M-row, 4-index store of about 1 GB, and a no-op once `sqlite_stat1` exists. That scaling is the reason the bounded mask was kept and the unbounded one rejected; a store with many more indexes is the case to watch, and the cost recurs only after statistics are removed.

The decision is recorded in code as a constant with a stated rationale rather than as configuration, because the values follow from the store's measured size rather than from a deployment choice. A host that cannot honour either pragma still opens and still serves; the mismatch is reported on stderr instead of being silently absorbed.
