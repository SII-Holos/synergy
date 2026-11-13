# Decision Record: Recover exact sealed knowledge through its original content owners

Status: implemented

## Problem

Service recovery rejected a fixed H0 namespace containing already published material, Skills or a nonempty applied knowledge collection. Allowing their record roots alone would miss incomplete immutable manifests, substituted inverse indexes, corrupt bytes and unprojected content created after H0. A policy journal cannot reconstruct those immutable facts.

## Decision

Publication, Knowledge and KnowledgeSelections provide read-only historical folds over the recovery owner's existing private disk inventory. Canonical codecs, key builders, portable path normalization and closure rules remain in their original owners. They mark only individually validated canonical keys; unmarked records and binary keys under these domains remain blocked. The temporary mark and deduplication tables grant no authority and are removed with the original inspection callback.

The publication fold binds original create receipts to their sealed uploads and referenced knowledge releases. It checks file identities, portable paths, parent-directory relationships, contiguous chunks and exact manifest counts. Live sealing and historical inspection share one full-file SHA-256 and manifest-line fold. Historical Skill inspection reuses the existing bounded UTF-8 frontmatter and ConfigMarkdown/SkillManifest parsers; actual bytes must yield the retained Skill descriptor. Upload and manifest deduplication lives in the bounded disk inventory, allowing multiple releases to share original content without retaining complete collections in RAM.

The knowledge fold checks item/version/upload/author links, publication receipts and current scope indexes. It retains historical author snapshots rather than rebuilding them from current account names. KnowledgeSelections shares ordinal, array-hash and complete-count validation with ordinary reads, and verifies each inverse item ordinal. Committed updates retain their original pointer, staged references, complete page identities and immutable manifest. Old committed updates may precede today's pointer; inherited Session summaries can reset revision; migrated manifests need no invented update owner.

Original publish expectedRevision and update page bodies are not retained. Their opaque original hashes are preserved exactly; the fold does not invent or replay those requests. Open, sealing, abandoned, missing-seal and other unsupported retained upload states fail closed. Artifact publication and other resource/member writers remain separate owning work.

The early service-only audit validates the actual Source snapshot and native checkpoint bytes before fixed H1 capture or permanent retirement. Target preparation validates the fixed H1 through the same owner fold. Existing bidirectional H0/H1 comparisons still require every unprojected fact to match; H1 content reconstruction is not implemented. Final Target transactions consume that verified inventory and retain the existing actual-byte checkpoint, metadata/count/location rechecks, native pins and COMMIT guards. No reader snapshot spans later write admission, no schema or SDK changes are introduced, and no second persistent recovery ledger is created.

Each nested disk-inventory iterator owns an independent prepared statement and disposes it on completion or cancellation. Reusing Bun's cached query statement across nested item/release folds caused a real cursor failure; the same original reader now supports these nested consumers without materializing the inventory in memory.

## Alternatives considered

**Whitelist publication and knowledge roots.** That cannot certify closure, indexes or actual bytes.

**Trust chunk hashes or a self-consistent rehashed manifest.** Only the shared full-file SHA fold proves that retained File.sha256 describes the actual concatenated bytes.

**Rebuild H1 immutable content in the guard.** New content requires owning reconstruction and publication; this unit refuses such deltas before source retirement.

**Call ordinary authenticated readers during historical validation.** Current authorization and side effects would change the meaning of retained facts. Pure owning readers validate original tuples without granting current execution or replaying work.

## Consequences

Public recover supports an actual service-only H0 material/Skill namespace with an existing nonempty project-applied collection when its unprojected H1 facts are unchanged. Actual Target content and selection survive ordinary cold startup, the original inactive key is retained and no Continue is dispatched.

The new public CLI test reproduces the previous root rejection, then passes a complete recovery and two cold Target reads. Its six unique cases cover missing manifest references, inverse-index substitution, corrupt actual Target chunks, self-consistent rehashed metadata with a wrong full-file SHA, and an H1 release reusing old bytes. Every negative retains Source format 2, a released original maintenance operation without retirement reservation, the held Target and the original key. Final static and adjacent existing owner checks are recorded in the unit manifest.
