# Decision Record: Encrypt organization recovery containers

Status: implemented

## Problem

A native namespace checkpoint can contain private canonical records and byte artifacts. Encrypting only its declared credential entries leaves those other files readable to anyone transporting the archive. A complete organization backup also needs a file inventory that can grow independently of a single JSON response or in-memory list.

## Decision

The organization Host recovery owner seals captured files into an authenticated container. It reuses Harness `SecretEnvelope` for encryption and authentication. The external versioned recovery key never enters the container. Logical file paths and immutable file descriptors live in encrypted inventory pages; every content chunk and the final root also uses that same canonical envelope implementation.

Captured files declare exact lengths and SHA-256 digests. The writer verifies them while merging arbitrary source slices into bounded 4 MiB chunks. File ordinal, chunk ordinal, archive identity, format purpose and key version bind their authentication. An authenticated final root commits to the inventory page digest, counts, total bytes and build identity. The writer uses an exclusive new directory and publishes its root after all files finish. Failed sealing removes only that owned incomplete directory and never overwrites an existing archive.

Verification and opening use one bounded parser and decryption walk. Inventory pages contain at most 128 descriptors; filesystem claims detect duplicate paths without retaining a lifetime set. Generated logical names reject escaping paths and reserved portable names. Opening requires an independent new private directory. Missing chunks, wrong keys, changed roots, substituted ciphertext, symlinks and incorrect totals reject the operation and remove opened private staging. The owner does not publish a native namespace, activate a Session or execute an archived file.

## Alternatives considered

**Encrypt only credential records.** Namespace records and artifacts can contain private Session content even when they are not credential records. Transporting that plain namespace would broaden private-data access.

**Load one archive or inventory into memory.** This adds an accidental growth limit to large hosted histories and published outputs. Independent pages and content chunks preserve bounded processing without a lifetime file quota.

**Add another encryption implementation.** Recovery would acquire different key, AAD and authentication semantics from the existing encrypted store. The container supplies its domain identities to the canonical envelope instead.

## Consequences

This container consumes already captured files; it does not establish their cross-namespace consistency. The operator coordinator must still acquire native maintenance and Snapshot captures, verify every underlying namespace through its canonical parser, include declared resource and hosted owners, report missing synchronization, reconcile later authorization and physical writers, and keep restored execution held. No ordinary organization account or Web route exposes this private container owner. Container completion alone is not complete PR-20 recovery or permission to open a restored deployment.

Ciphertext files expose their physical existence and approximate lengths. Canonical metadata, logical filenames and byte contents are authenticated encrypted data. Plaintext opening is a trusted Host staging operation and does not claim secure erasure of filesystem blocks after cleanup.

## Verification

Organization `test/backup/archive.test.ts` seals actual temporary files/streams, restores multi-chunk binary and empty bytes, spans multiple inventory pages, and verifies original hashes. It exercises wrong keys, changed roots, substituted archive identities, symlinks, missing later chunks, repeated and escaping names, cancellation/iterator drainage, failed sealing cleanup and preservation of existing output. A real SQLite namespace with private records, encrypted credential recovery and binary references passes through the container and the original native parser into an independent Home with its own required publication fence. These small isolated fixtures do not establish performance for a multi-gigabyte deployment or implement the complete deployment recovery policy.

## Related

- [Namespace checkpoints](2026-11-11-pin-portable-namespace-checkpoints-and-fence-restoration.md)
- [Authority recovery evidence](2026-11-11-retain-redacted-authority-history-for-recovery.md)
- [Organization service](../../../architecture/organization.md)
