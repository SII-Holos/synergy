# Decision Record: Adopt frozen maintenance history in the native restore transaction

Status: implemented

## Problem

A restored namespace contains the source's frozen maintenance operation and current pointer. Treating that pointer as a target lease would confuse two physical writers. Deleting it or initializing a new baseline would discard the evidence that restoration is still held. A caller-provided transaction or manifest cannot establish that native records came from a completely verified checkpoint. Finalization can also finish its callback before the database commits, so checking a Home permit only inside that callback leaves a lifetime gap.

## Decision

The canonical `StorageCheckpoint` importer creates opaque import evidence only after its Portable parser has consumed the complete archive and verified its footer and digest, inside that original Store's actual writer callback. The evidence binds Runtime, Store configuration, artifact ports, logical restore ID, full namespace manifest and transaction identity. `assertImport()` rejects copies, snapshots, foreign transactions and ended callbacks. It grants no authority to reconstruct native files or operate outside that callback.

`guardImport()` accepts additional pure guards only through that live evidence and writer. They append to the native import's actual driver commit guard; they cannot replace its captured cancellation signal or caller guard. Owners register final checks of their own still-live evidence. The import callback evidence and `assertWriteTransaction()` are deliberately unavailable after their callback ends, so final guards do not extend those capabilities. They independently recheck the original Home permit, installed-owner evidence and immutable request. Portable import forwards the captured guard to the same database transaction, including its final commit boundary.

`HomeRestoration.verifyInstalledOwner()` reuses the native Home owner reader and assertion to verify permanent format three against the actual intent's owner, installation ID and incarnation. It clears earlier proof before asynchronous verification and retains new evidence only in that permit's original callback frame. `assertInstalledOwner()` is a pure consumer of that actual verification. Neither a marker DTO nor the pre-SQL pending-owner subset assertion supplies it. Installing the owner performs this verification too; every cold or later callback must verify again. Snapshot installation consumes the same owner method instead of maintaining a separate Home verification path.

`RuntimeMaintenance.adoptRestoration()` operates only inside that verified raw import transaction with the original Home permit/request and installed-owner evidence. It reads the actual imported current pointer and source operation from that transaction. An absent, unsupported, non-backup or non-frozen source operation blocks adoption; it never seeds a replacement source baseline. The complete original operation, owner records, requests and historical receipts remain unchanged.

The target's new operation uses the native installation ID and the existing `recovery-held` phase and restore purpose. Its hold-contract digest binds the original request and source cohort without claiming that a target cohort drained or that the old writer retired. An immutable version-one reference associates this operation with the same incarnation, restore request, namespace hash and preserved source operation. It carries no second phase. The current pointer changes to the target hold in the same transaction as all imported records, relocated byte references and the raw import receipt. Repeated adoption within the same finalizer checks its exact retained reference. Failed finalization, cancellation or final native-guard rejection rolls the whole batch back.

No executable target lease is issued. Ordinary admission and mutation remain blocked after cold reopening, and generic release refuses source and fabricated target leases. The existing maintenance operation schema is unchanged; the restoration reference is a new owner-local record family with no prior data to upgrade. Native maintenance protection is registered during service composition before storage or sealing, including restricted recovery. Restricted mode still constructs no application migrations, authentication or transports.

## Alternatives considered

**Delete or release the copied source hold.** That would assert current writer safety from historical state and discard its original unresolved obligations.

**Accept any live-looking transaction or supplied manifest.** Only the actual complete import writer can prove the restored namespace represented by those bytes.

**Require callers to remember an optional commit guard.** A real delayed transaction committed after its Home callback had ended. The adopting owner must append its own native final guard through the importer.

**Reuse import evidence in the final commit guard.** Its callback lifetime has ended. Independent native Home evidence retains its own lifetime and must be rechecked there.

**Treat an existing format-three marker as fresh verification.** Cold or ended callbacks cannot carry an earlier native file check into a new installation frame.

## Consequences

Restoration preserves source maintenance history while installing a distinct target hold atomically. This is not a ready receipt, target writer reconciliation, old-writer retirement, current ACL continuity, fresh signing/authentication, restored Session execution policy or permission to replay historical work. The full coordinator must still compose every required native facet and actual owning proof before allowing ordinary reads or execution. Pack-protection retirement and the eventual controlled release of a recovered deployment remain separate owner work.

## Verification

`test/storage/runtime-maintenance-adoption.test.ts` uses actual selected Harness maintenance owners, native target Homes, independent Stores and fully protected checkpoints. It verifies same-transaction rollback and cold target rejection, preserved source history, fake/read-only/foreign/expired import evidence, idempotent adoption, missing source frozen evidence and the distinction between a marker and fresh native verification. An actual last cleanup write triggers cancellation and rolls back the import, hold, reference and receipt. Another actual cleanup barrier lets the native Home callback end before commit: the original implementation incorrectly resolved; the appended driver guard now rejects specifically because the callback ended and leaves the whole namespace unpublished.

`test/lifecycle/home-restoration.test.ts` checks per-callback and cold owner verification, expired permits, pending-owner subset refusal and invalidation after failed native verification. `test/backup/service-native-install.test.ts` exercises the real restricted service: install format three through its native facet, import the fixed service namespace, atomically adopt its source operation, reopen cold and retain both the target hold and inert application authority. Existing checkpoint and service recovery tests retain their completeness, secret recovery, native preparation and startup coverage.
