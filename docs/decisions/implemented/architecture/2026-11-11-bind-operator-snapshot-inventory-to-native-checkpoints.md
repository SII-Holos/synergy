# Decision Record: Bind operator Snapshot inventory to native checkpoints

Status: implemented

## Problem

A namespace archive captures Snapshot ownership at one SQL revision. Reading the live owner afterward can select another retention identity, while reading live stored manifests can miss roots removed after that revision. Accepting an arbitrary owner body would also bypass the ordinary canonical ownership gate. A read handle that outlives its physical pin can race deletion even when its metadata is correct.

## Decision

The trusted Host `SnapshotMaintenance.withCapture()` entry holds the Home Snapshot lease around the complete caller operation. Its `exportArchive()` method invokes the canonical namespace exporter itself, then consumes `StorageCheckpoint.entries()` with the exact returned manifest as `expected`. The single authenticated, decrypted scan must reach its footer before any archive handle is returned. The captured owner, repository format, stored-root keys and historical Part references are indexed in a disposable SQLite database with a bounded page cache.

Native retained refs are enumerated under that same physical lease through the captured retention identity. Stored roots come from the fixed archive's metadata, and legacy ownership enumerates the tree objects its native reader can access. Repository layout follows the captured repository format, independent of the Runtime's selected backend. The index seals the root inventory before the caller receives a handle and rejects a historical Part root without captured ownership. This neither changes the source owner nor authorizes reads through its replacement.

`owners()` returns opaque references recognized by an internal weak registry. Their read and description methods require the exact active Runtime, Store and artifact directory. A cloned object or caller-supplied owner body is insufficient. The description binds the normalized owning record and layout to the actual namespace manifest. Root reads use the immutable capture index. Ordinary `SnapshotStore.roots()` still resolves the current canonical owner and active storage mode.

The callback must drain every started export and reader. Early iterator return is incomplete, and callback completion revokes escaped references. Runtime shutdown closes capture admission, aborts active operations and drains them before Snapshot and Storage cleanup. Snapshot leases precede artifact checkpoint gates; no inverse acquisition is introduced.

## Alternatives considered

**Read the live owner after namespace export.** A concurrent ownership switch can combine an earlier SQL archive with a different retention identity.

**Trust an owner object passed to the reader.** Its fields cannot prove that it came from this Runtime's actual checkpoint or that a physical pin remains held.

**Parse encrypted records independently.** Recovery material, footer validation and actual-consumption hashes remain owned by the canonical checkpoint reader.

**Choose layout from current Runtime configuration.** An operator can inspect data whose activated format differs from the selected execution backend; configuration does not replace captured storage authority.

## Consequences

Real fixtures capture encrypted records, change the live owner, remove live stored manifests and retain the original fixed inventory. They reject cloned references, switched artifact directories, unfinished reads, missing historical roots and reads after callback closure. Historical version-2 legacy ownership normalizes through its existing owning migration. A real checkpoint-reader barrier proves that Runtime close aborts and drains capture before storage closes. A Runtime/backend mismatch fixture reproduces an empty inventory under configuration-based selection and retains the native roots under captured-format selection.

This is an operator inventory and pin primitive. It does not itself produce a complete Git, Asset, Workspace or deployment archive, authorize an organization administrator to read private bodies, or reconcile unique physical writers. The operator coordinator must first drain its owning mutation cohort and then consume the actual Snapshot content segments within this callback before claiming a complete backup. Immutable Git graph validation, stored graph reconstruction and segment/container integration remain with the Snapshot backup owner.
