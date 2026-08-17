# Decision Record: Base tool-output retention on file mtime

Status: implemented

## Problem

`Truncate.cleanup()` decided file age by decoding the `tool_*` id timestamp. The id encodes `create(prefix, descending, timestamp)` as a 48-bit payload, but the epoch millisecond timestamp needs 41 bits, so only the low 36 bits survive (a ~2.18-year modulus). After the clock crossed the `26 × 2^36` ms boundary on 2026-08-14, freshly written outputs (0–3 days old) decoded as _smaller_ than the 7-day cutoff and were deleted by the next cleanup, destroying recent tool output and failing the retention test.

## Decision

`Truncate.cleanup()` now uses each file's `mtime` (`fs.stat`) against the retention cutoff instead of decoding the id. Tool output files are always written by `Truncate.output()`, so mtime is their creation time and is exact for the retention decision. The test sets file ages with `fs.utimes` rather than relying on id-encoded timestamps.

## Alternatives considered

- **Encode full timestamps in ids** — rejected: the id format is shared by ordering (ascending/descending) across sessions, messages, parts, and more; widening the timestamp field would change id length and ordering semantics everywhere.
- **Treat id timestamps as mod-2^36 and compare with wraparound-aware arithmetic** — rejected: ambiguous at the boundary (a 3-day-old and a ~2-year-old file can decode to the same value) and still wrong for retention.

## Consequences

Retention is correct across the 2^36 ms boundary and no longer depends on id encoding details. Cleanup now does one `stat` per entry, which is negligible relative to the unlink it may perform. Id decoding stays unchanged for ordering semantics.
