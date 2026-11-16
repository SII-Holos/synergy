# Decision Record: Spool producers before artifact adoption

Status: implemented

## Problem

`Storage.prepareBinaryStream()` held the destination artifact gate while consuming its caller's iterable. A producer reading retained bytes or populating a cache in the same Store needed that gate itself. The real handoff receiver consequently waited on its own target owner before private staging could complete.

## Decision

Runtime-wide producer admission precedes spool creation and consumption. Sixteen concurrent slots share the original total pending limit of 1024 across all keys, Stores and backends. Queued producers open no file and consume no bytes. Nested producers use an idle slot or fail immediately with the ordinary busy error, avoiding dependency cycles behind their own parents. These limits bound active resources and pending requests; they impose no history or artifact-size quota.

Accepted producers keep the destination artifact gate free while preserving inherited cancellation and the selected artifact key. Their bytes stream to an exclusive private Runtime cache spool using bounded writes and an open file descriptor. Producer failure or cancellation closes the iterator and discards that spool before backend preparation or publication.

The attempt captures concrete Runtime, Store, artifact directory and object configuration values before asynchronous work. It rechecks those values during consumption and backend reading and before retaining the prepared token. Cached object backends keep a copied configuration record. A mutable handle or object-options record cannot retarget an accepted attempt to another location or writer.

After complete producer consumption and synchronization, the original artifact gate admits backend preparation. The local pack or object owner reads bounded chunks from that descriptor through its existing stream implementation. The resulting checksum and byte count must match those observed during producer consumption. The original prepared-token owner pins the returned immutable pack inside the same gate before any collection can intervene. Temporary cleanup failure disposes an otherwise unreturned prepared token.

The spool is temporary cache, outside the configured artifact backend. Object deployments gain no local artifact fallback. Local codec selection, object format-two pages, exact preparation receipts, upload intents, uncertain-commit retention and publication remain with their existing canonical owners. The object owner still pins every upload before its external write; interrupted direct backend uploads retain their existing collection requirements. A producer that fails before backend preparation performs no upload.

The complete preparation promise is registered before its first asynchronous wait and remains owned through spool cleanup. Runtime and organization-service shutdown first drain their accepted caller domains, close new top-level producer admission, and wait for queued and active preparations before closing the backend. An active producer can finish its exact nested preparation dependencies and object adoption while that backend remains open. Raw `TransactionalStore` owners retain their existing obligation to await their native calls before closing; this adds no SQL closing bypass.

## Alternatives considered

**Make the artifact gate reentrant.** Nested cache writes and collection would then run while the owner assumed exclusive artifact preparation, weakening its pin and reclamation invariants.

**Remove the gate around all preparation.** A completed physical artifact could become visible to collection before its prepared-token pin existed.

**Buffer the complete producer in memory.** Handoff objects and native binary artifacts have no small aggregate-size guarantee. A bounded temporary spool preserves that property while allowing caller-controlled producer work outside the critical section.

## Consequences

The real same-Store retained-byte producer changes from a bounded rescued deadlock to successful prepared publication. The original two-Home frozen-source receiver completes private target staging without exposing a Session or bypassing corrupt cached content. Fixtures preserve source read pins across deletion, destination preparation across collection, inherited cancellation, iterator cleanup, checksum rejection and the original selected key. Cross-Store capacity barriers verify that a seventeenth producer opens no spool; nested saturation fails without waiting. A real Runtime closure waits for active and queued byte adoption before closing the actual backend. Object fixtures retain paged manifests, historical format-one reads, failed upload handling and lost preparation/publication acknowledgement behavior.

Preparation uses temporary disk proportional to input size and reads it again during backend preparation. Local pack preparation can transiently retain an additional native stream file. Cache files are not authority or recovery evidence; they are removed when the attempt completes. Producer callbacks remain responsible for observing cancellation during their own outstanding external work.
