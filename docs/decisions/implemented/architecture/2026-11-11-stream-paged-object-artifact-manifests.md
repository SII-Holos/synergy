# Decision Record: Stream paged object artifact manifests

Status: implemented

## Problem

Large Session transfers need to preserve immutable evidence without buffering complete artifacts. A single manifest array also imposes a total chunk ceiling and makes verification and garbage collection retain metadata proportional to all content in memory.

## Decision

Write object artifact format 2 as bounded content chunks and bounded manifest pages. The root manifest records the complete byte digest, counts and final page hash; each page binds its index and predecessor. Canonical SQL page records reproduce that committed chain for forward reads. Readers verify the complete page closure before yielding content, verify every remote object and finish with the complete byte digest. Existing format 1 objects remain readable and verifiable; new writes use format 2 without rewriting historical references.

Persist a stream intent before consuming input and pin each chunk, page and root hash before uploading it. Completion atomically publishes the root catalog and page index, replaces temporary stream pins with a sealed preparation intent, and leaves business-reference publication to the existing transaction owner. Interrupted input and cancellation cannot publish a partial reference. Uncertain preparation or publication acknowledgments retain durable intent protection; only explicit retirement of a physically stopped, fenced previous writer can clear its unknown work.

Use paged SQL mark and sweep records for retained object hashes and collection candidates. This retains shared chunks, complete and incomplete preparations, validation and backup/import pins without a process-wide set of all chunk descriptors. Orphan stream objects follow the existing seven-day unreferenced grace period. Deletion marks metadata first, removes only exact unretained hashes, and resumes after interruption. Validation pins a frozen database inventory in SQL and verifies it in bounded pages.

## Alternatives considered

**Buffer an artifact and write one chunk array.** This retains whole-artifact memory and a manifest-size ceiling.

**Fall back to local temporary packs.** Object deployments would again depend on the Runtime Host for recovery.

**Upload before recording object pins.** A crash or collection pass could lose in-flight bytes.

## Consequences

Streaming memory follows chunk and page sizes rather than total artifact size. Manifest metadata and preparation pins add SQL writes, while content remains deduplicated by hash. Format 1 compatibility remains necessary while historical references exist; converting them is an explicit offline ownership operation. Verification, garbage collection and backup pins cover both formats. The focused storage contracts exercise a real 516 MiB paged stream, cancellation, corruption, old-format reads, uncertain acknowledgments and writer retirement.
