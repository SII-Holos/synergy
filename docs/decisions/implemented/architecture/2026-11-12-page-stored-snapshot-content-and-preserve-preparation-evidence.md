# Decision Record: Page stored Snapshot content and preserve preparation evidence

Status: implemented

## Problem

An aggregate Snapshot manifest grows with every pack chunk. A default total-byte ceiling limits retained history independently of available storage, and keeping every prepared chunk token until publication makes memory grow with the content. A private version-3 retention identity also differs from its logical Session: checking only the private identity at publication misses deletion or a mutation fence on the logical owner. A lost SQL acknowledgement must not discard bytes that the committed root already references.

## Decision

The stored Snapshot owner writes a version-2 bounded header and immutable binary descriptor pages under `snapshot-v2/<scope>/content/<retention>`. Storage identity is independent of execution Session identity: an adopted retention ID can name a frozen or surrendered former Session while its active logical owner retains new history. Each page contains at most 128 chunk descriptors, each chunk contains at most 4 MiB, and the header seals descriptor order, counts and total bytes with a SHA-256 digest. Readers verify page order, contiguous pack/chunk indexes, exact lengths and the final seal while retaining one descriptor page. Early termination and cancellation cannot produce a complete scan. The format has no aggregate pack, chunk or byte quota; a Host can explicitly select an operation byte budget.

Preparation uses the canonical binary owner and a durable intent before the first content reference. Each chunk's prepared token is released after its native reference commits. The root header and intent removal commit together only after the complete Git pack is prepared. Native writer admission rechecks cancellation and the logical Snapshot owner, its exact retention identity and the registered mutation guards in that transaction. Direct offline conversion can prepare unowned content before publishing its final Snapshot owner; that trusted path does not invent a logical Session owner.

An uncertain commit preserves preparation references. A retry reads the canonical header before preparing again. `SnapshotMaintenance.collectStoredPreparations()` takes the exclusive Scope lease and exact root lock, preserves content selected by the canonical header, and removes only unreferenced preparation content. Release removes retained content while leaving preparation discovery until that native owner can reconcile it. Unknown manifests block cleanup.

The central `stored-snapshot-content` maintenance migration reads version-1 headers, verifies each existing chunk and relinks its native artifact reference into the new immutable content ID without copying bytes. It leaves protected legacy Session paths untouched. A root-specific legacy-input fence commits with each current header; release also installs a retention-wide fence. If a canonical root is removed, its preserved compatibility header cannot become authoritative again. Ordinary startup defers historical conversion. The live inventory merges bounded current and unfenced legacy windows; fixed checkpoint capture uses the same header and fence classifiers. Existing compatibility readers remain named and validated; new writers produce only version 2. Local-content conversion uses the same canonical manifest parser and size calculation.

## Alternatives considered

**Increase the aggregate array bounds or default byte budget.** That retains memory growth and makes a storage window into a product quota.

**Keep all prepared tokens until the root commits.** The canonical per-chunk references already pin the content, while the preparation intent supplies durable cleanup discovery without retaining an unbounded token array.

**Use the retention identity as the Session mutation identity.** Adopted ownership can resolve to a private preparation identity. Its logical Session deletion and epoch fences must be checked independently in the publication transaction.

**Keep immutable content under the former Session path and exempt those writes from epoch guards.** A storage identity can match a frozen execution identity. Moving new content to its Snapshot owner avoids weakening protection on that Session's retained records.

**Delete legacy input during a frozen owner's migration.** Native reference relinking preserves bytes without mutating protected source paths. Persisted fences prevent that preserved input from restoring retired authority.

**Remove preparation data after every error.** A committed transaction with an unknown acknowledgement may already reference that exact immutable content.

## Consequences

Real SQLite/object fixtures cover binary recovery after complete cache loss, ordered 100001-descriptor traversal, bounded first-page reads, cancellation while waiting for the actual writer, missing descriptor pages, changed logical owners, native mutation fences, unknown acknowledgement reconciliation and valid chunk checksums whose Git graph lacks the claimed tree. Real frozen and surrendered epoch fixtures migrate preserved version-1 inputs and admit new history for an active alias while rejecting publication and release through the frozen logical owner. Retired current roots do not reappear from compatibility input. The owning migration fixture retains actual historical chunk bytes and verifies restored content after cache removal. The large-descriptor fixture validates metadata growth; it does not claim a multi-gigabyte payload transfer.

Git pack installation still validates the requested tree closure before publishing local retention refs. Stored descriptor paging is independent of the operator's complete Snapshot segment and deployment maintenance. Native and legacy repository inventory, fixed-checkpoint stored graph reconstruction, encrypted deployment packaging and unique-writer recovery remain separately owned operations.
