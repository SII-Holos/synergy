# Decision Record: Read native Part fields through regenerable pages

Status: implemented

## Problem

Private transcript readers need exact large text and tool fields without hydrating a whole Part. Replaying the beginning of a native stream for each byte range makes sequential reading quadratic. First-time UTF16 conversion and hashing can also exceed a finite request deadline, so restarting that work on each request creates an implicit content-size limit.

## Decision

Expose bodyless native headers, exact field descriptors, preparation status and bounded UTF8 byte ranges through `SessionHistory`. Text and reasoning use the canonical PartContent blocks; tool inputs use their exact native execution artifact; completed output uses its retained complete artifact or canonical StoredToolOutput record. Missing original output remains explicitly partial. Compaction recovery summaries use the text field, while retry headers expose only the error name. Native metadata projection does not authorize remote access.

Materialize a requested native revision into regenerable, fixed 128 KiB pages under `part_field_cache`. Bind the generation to the canonical record revision and selected artifact references, verify complete native byte counts and hashes, then publish its pointer only after checking the native revision again. Each page retains its own checksum. Byte ranges directly select at most two pages; offsets may divide a UTF8 scalar, so consumers decode successive bytes as a stream. Cache state is never a source of Session identity, original text or migration authority.

A Runtime-owned worker prepares one field source at a time. Its pending queue holds at most 16 native identifiers and 64 KiB of identifier metadata; overflow reports a busy preparation state for retry. It does not retain queued bodies or completed descriptors in a Runtime-wide cache. Preparation returns the stable native version and measured bytes before a hash is available. Caller cancellation ends that caller's wait; Runtime shutdown cancels and drains the worker before closing Storage.

Field leases serialize cache publication, bounded reads and collection under the existing single-Runtime Home ownership. Replacements retire obsolete generations in pages. A fifteen-minute worker considers up to 64 field identities per pass, retires interrupted preparations and releases generations not read for seven days. Collection and preparation share cancellation and shutdown drainage. Cache records and pages can be removed and rebuilt from the canonical owner; no aggregate content quota is introduced.

Maintain the tool Part lookup as a derived native execution index keyed by run, message, call and tool identity. Journal projection and recovery update the index in the same transaction as the execution record and head. Central per-owner migrations build historical indexes; foreground field reads perform one exact lookup and never scan every tool in the run. Equal-time conflicting input evidence fails explicitly.

## Alternatives considered

**Skip preceding bytes on every request.** This preserves bounded memory but repeats all earlier I/O and decompression.

**Keep converted fields in memory.** This retains arbitrary historical bodies across unrelated reads and loses preparation on restart.

**Increase the request timeout.** This gives no reliable upper bound on first-time work and still restarts incomplete conversion after cancellation.

## Consequences

First preparation performs linear native I/O and writes a disposable page cache. Later ranges have constant bounded page work, including after restart. Real-storage tests verify exact Unicode bytes, original versus partial output, index migration and rollback, cache seek counts, cancelled waiters, failed publication, active-reader collection, restart reuse and Runtime drainage. Remote signed Read transport and attachment download authorization remain with their respective owners.
