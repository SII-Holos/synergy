# Decision Record: Bound the SQLite worker's memory map and page cache

Status: implemented

## Problem

The authoritative SQLite worker opened both of its connections on engine defaults chosen for a database far smaller than this one. `mmap_size` was `0`, so reads went through the page cache and `pread` instead of a memory map, and `cache_size` was SQLite's default `-2000` — a 2 MB page cache — against a store that has measured 32 GB.

The pragmas that fix this are also the ones whose failure is silent, which is the constraint that shapes the decision. `PRAGMA mmap_size = N` does not throw when it cannot honour `N`: it clamps against the compile-time `SQLITE_MAX_MMAP_SIZE`, and it is ignored entirely where memory-mapped I/O is unsupported. An unknown pragma is ignored rather than rejected. A bare `PRAGMA name = value` followed by no error is therefore not evidence that anything changed.

## Decision

**Both worker connections ask for a 256 MiB memory map and a 64 MiB page cache, read each value back, and report the ones the engine did not honour. Windows is left unmapped.**

`cache_size` is set to `-65536`, a negative byte form, so the cache keeps its byte size if the page size ever changes; the positive form would silently mean a page count. It applies to the reader as well as the writer, because the page cache is per connection and the reader is the connection serving ordinary reads.

`mmap_size` is set to `268435456` on both connections, and is **not requested at all on Windows**. Windows cannot truncate a memory-mapped file, so a mapping would pin the file's size and silently defeat the incremental auto-vacuum that governs this store's capacity. This is a platform exclusion rather than a probe: the platform either supports the operation safely or it does not.

Every value is read back through the same connection that set it. `cache_size` has no compile-time cap, so any value other than the request means the pragma never applied and is reported. `mmap_size` is clamped legitimately, so only a returned `0` — memory-mapped I/O unavailable on this host — is reported. A rejected or clamped pragma writes one redacted line to stderr and never throws or fails startup: the store must open on a host whose engine cannot do this.

Nothing else in the open path changes. `auto_vacuum`, `journal_mode`, `synchronous` and `journal_size_limit` keep their values and their load-bearing order.

## Alternatives considered

**Refresh planner statistics at open with `PRAGMA optimize`.** This was implemented first, because the store runs no `ANALYZE` anywhere and so carries no `sqlite_stat1` on a production database. It is rejected on measurement, and the measurement is the whole point of the entry. On a copy of a production store — 34 GB, 11.6M live rollout rows, no `sqlite_stat1` — the refresh took **121.49 s** inside an `open` action that carries no `maintenance` flag and therefore runs on the ordinary 30 s request deadline. A statement killed at that deadline triggers the liveness probe and marks the store terminally failed, so the store could **not be opened at all**: the index the open path also creates was never created, and every retry repeated the same doomed build. Moving the refresh to the maintenance budget made it survive but not pay: as a maintenance operation it took **79.30 s** and produced **zero** rows of `sqlite_stat1`. A bounded `ANALYZE` with `analysis_limit=400` did produce statistics, in 21.57 s — and then changed the plan of **none** of the six real read shapes the store issues (key lookup, batched key lookup, session page, message page, kind page, node children). Every one already used its intended index. Statistics buy nothing here and cost 22-121 s, so nothing ships.

This is the second time this store's planner behaviour has been reasoned about from a smaller fixture and been wrong; `benchmark-storage.ts` grows an owner-enumeration line for the same reason, and the lesson belongs to the shape of the store rather than to any one statement.

**Request the documented first-open mask, `PRAGMA optimize=0x10002`.** SQLite documents this mask for a connection that will be long-lived, which is exactly this connection. Measurement refuted it before the larger refutation above: bit `0x10002` _clears_ `0x10`, and the SQLite source sets `nLimit = 0` when `0x10` is absent, which is an **unbounded** `ANALYZE` over every index. On a warm 6M-row, 4-index store the two masks measured 814-850 ms against 73 ms, and the unbounded run analyzed 545,455 index rows against 2,001.

**Set `mmap_size` on Windows as well.** Simpler, and the read-back would report the clamp. It is rejected because the failure is not a clamp but a semantics change: a mapping that cannot be truncated keeps pages that `incremental_vacuum` freed, so the store would stop converging on its byte budget — the exact control loop the retention work fixed. A platform that cannot honour the operation does not get the request.

**Skip the read-back and trust the request.** This is what the code would look like if written from the pragma documentation alone, and it is the shape that hides a misconfiguration indefinitely: `mmap_size` on a clamped host reports no error, so the only symptom is a performance difference nobody attributes to the pragma. The read-back costs one query per pragma at open and converts an invisible mismatch into one stderr line.

## Consequences

The store's read path now maps 256 MiB and caches 64 MiB on each connection, which is a fixed memory cost the worker holds for its lifetime, paid in exchange for not driving every read through a 2 MB cache. `mmap_size` and `cache_size` are per connection, so a test that opens its own `Database` cannot observe them; the assertions go through the driver's writer and reader.

The values are constants with a stated rationale rather than configuration, because they follow from the store's measured size rather than from a deployment choice. A host that cannot honour either pragma still opens and still serves; the mismatch is reported on stderr instead of being silently absorbed.

The decision this entry replaces is a narrower one than it first appears: the store still has no statistics on any connection, and every plan it produces is costed from SQLite's built-in guesses. That is measured to be sufficient for the read shapes this schema issues, and the shape that needed correcting — retention's owner enumeration — was corrected by an index rather than by statistics.
