# Decision Record: Pin portable namespace checkpoints and fence restoration

Status: implemented

## Problem

A SQL snapshot can retain an artifact location after the live reference changes. Reading the later key during backup can pair old metadata with new bytes, and collection can remove the original pack. Copying an active database file does not prove a coherent namespace. Importing its original artifact locations into another Home or content backend also leaves references to bytes that destination does not own.

## Decision

The native Storage checkpoint holds the existing artifact gate and, for local packs, the existing cross-process pack lock. It exports one MVCC portable snapshot and reads its fixed immutable artifact locations through the canonical local or object stream owner. Object pages query SQL after the metadata snapshot closes while the artifact gate remains held. Re-entering that SQL snapshot from an object stream would otherwise deadlock its reader. Callback completion cancels and drains its readers and rejects unfinished operations; escaped ports cannot read after release.

The trusted Host namespace archive writes the portable records, immutable bytes and declared secret recovery entries into a private staging directory. It verifies hashes and lengths before publishing the final manifest/directory. Each secret entry reuses the canonical authenticated secret envelope, with an external versioned 256-bit recovery key and exact archive/namespace/entry identity. The archive contains ciphertext and descriptors, never that recovery key. The existing encrypted vault and archive recovery share one encryption implementation and preserve the vault's stored envelope format. A failed export does not publish a complete archive.

Restore first verifies the complete portable inventory, every referenced byte file and every encrypted recovery entry. It requires an independent empty namespace. Native binary preparation publishes only private staging references; the final transaction relocates the archived references to destination-owned bytes and runs the required owning-domain finalization hook before publication. The empty-namespace precondition is checked again inside that same final writer transaction, before any imported record, allowing only this restore's staging and native physical bookkeeping. A concurrent ordinary writer, another restore's staging or unrelated receipt/event outbox prevents publication. For object-backed staging, the live opaque prepared token supplies an owner-checked immutable copy of its existing successful seal receipt. That exact tuple commits with this restore's staging reference and is compared against actual native receipt identities, request hashes and successful results; a similar operation prefix is insufficient. The native completed-operation receipt is reconciled before that precondition is applied again. Failed finalization rolls back ordinary records and references together. Target object/pack bookkeeping is rebuilt by the native destination owner rather than adopting another backend's physical catalog or pins. Operation receipts reconcile an identical completed restore without running finalization twice.

Portable export, archive inspection and import share one strict streaming parser. Page/frame bounds do not become lifetime object quotas. Unknown nested canonical fields remain intact. File and directory entries reject symlink substitution, ciphertexts have finite per-record bounds, and incomplete/corrupt inventories do not publish ordinary restored records.

Trusted capture owners consume `StorageCheckpoint.entries()` for logical records, including independently protected entries. This stream and `verifyArchive()` share the canonical recovery decoder and portable parser. Capture consumers pass the actual exporter's returned manifest as `expected`, binding the read to that export even if the directory is replaced by another valid archive. The same consumed bytes must match the manifest and footer, every recovery key must resolve, and native artifact references validate before successful completion. An early break or returned/cancelled iterator cannot certify a complete capture; incomplete consumption rejects. Capturers keep any derived indexes private until the iteration completes. This port does not expose ordinary account downloads or make physical locations an authorization grant.

## Alternatives considered

**Copy live SQLite files and the current artifact directory.** These have independent lifetimes and cannot establish the captured metadata/byte relationship.

**Read artifacts by their current key after export.** A changed key can resolve a different immutable object than the snapshot declares.

**Import original object locators.** Different Homes and object backends do not own the source writer's physical catalog and retention pins.

## Consequences

This is a trusted Host storage primitive, not an organization administrator export permission. Archives may contain private canonical bodies and cannot be exposed as ordinary Web downloads. The organization backup owner must still coordinate all hosted/resource/Snapshot namespaces, report checkpoints and missing dependencies, install a new deployment identity, review post-checkpoint authorization changes and reconcile unique execution writers before reopening execution. A completed namespace archive alone does not establish complete deployment backup or authorize replay, continuation or physical-process takeover.

## Verification

Harness `test/storage/checkpoint.test.ts`, `checkpoint-entries.test.ts`, `checkpoint-archive.test.ts`, `checkpoint-receipts.test.ts`, `prepared-binary-evidence.test.ts`, `portable.test.ts` and `test/secrets/{envelope,encrypted-store}.test.ts` exercise actual SQLite, independent Homes, local and object-backed content, multi-chunk binary and empty-byte round trips, retained unknown fields, current-reference removal, reader lifetime, authenticated recovery identity, missing keys/bytes, failed export cleanup, atomic final fencing failure, held native preparation with competing record/artifact/other-restore/receipt/event writers and exact restore retries. Logical-entry tests recover protected owner/body records and reject early iteration, cancellation, unavailable keys and a removed footer even when an outer descriptor is rewritten. The object case first reproduced the nested SQL snapshot deadlock and then passed without local pack fallback.

## Related

- [Agent storage](../../../architecture/agent-storage.md)
- [Organization persistence](../../../architecture/organization.md)
- [Offline content conversion](2026-10-09-convert-local-content-under-offline-ownership.md)
