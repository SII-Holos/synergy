# Decision Record: Capture complete Snapshot segments and stage restoration

Status: implemented

## Problem

A fixed Snapshot root inventory contains no Git bytes. Native repositories can retain unclassified objects and custom refs beyond a Session's selected trees; legacy readers can depend on a shared object pool. Stored content must be verified against its actual archived descriptors even when the live cache contains a healthy tree. Replaying metadata into a temporary copy of the whole source namespace would duplicate private state and storage merely to locate those bytes.

## Decision

The existing trusted `SnapshotMaintenance.withCapture()` port adds `exportSnapshots()`. Its archive reference must belong to that exact active capture, including when no owner exists. The Home pin covers namespace export, fixed inventory, complete Git/content consumption and segment publication. Runtime closure aborts and drains the operation.

The Snapshot segment owner consumes the canonical authenticated checkpoint entry reader with the actual exported manifest. A disposable SQLite index retains selected headers, legacy fences, artifact references, physical repositories and root identities. Header and descriptor parsing remains in `StoredSnapshotContent`; recovery decryption and Portable parsing remain in `StorageCheckpoint`. The trusted native artifact stream checks the actual consumed bytes against their exact length and checksum, rejects linked files and incomplete reads, and preserves cancellation reasons. Its descriptor is not a user-facing read capability.

Native and legacy repositories export complete object inventories through `SnapshotTransfer.Catalog`, including unclassified content. Exact ordinary and symbolic refs and HEAD are recorded separately. Stored layouts reconstruct an independent Git graph from selected archived headers, bounded descriptor pages and exact archived artifact references. The captured repository format excludes the live stored cache. Every root and complete graph is validated before a segment can publish.

Prepared packs and independently addressable metadata use a temporary canonical Storage namespace. The output reuses `StorageCheckpoint.exportArchive()` and binds its original namespace ID and record footer. Metadata encryption shares the canonical recovery key provider. The outer deployment archive must authenticate and encrypt all segment files before granting any distribution authority.

`SnapshotMaintenance.withRestoredSegment()` verifies the segment and parent namespace, installs its packs into independent private repositories and validates root/ref/count closure before invoking its callback. The callback sees only that Runtime's current private staged paths. Its readers must complete; cancellation and closure drain all started readers and remove private staging. This operation writes no active Snapshot ownership, Session record, driver epoch or continuation input. Deployment publication and execution reconciliation remain with the operator coordinator.

Private capture and restore repositories request an empty template through the canonical Snapshot initializer. The receiving Host's configured Git template must not contribute objects, refs, hooks or alternate stores to archived history. Restoration checks the actual complete ref count as well as every expected name, target and symbolic destination; HEAD reference names pass Git's own format validation. Ordinary Snapshot initialization keeps its existing template selection.

## Alternatives considered

**Export only the selected tree roots.** Whole deployment recovery must also retain unclassified native/legacy objects and exact historical refs, which a selective Session archive intentionally excludes.

**Use the live stored cache after namespace export.** It can contain a different graph or hide damaged archived content. A captured layout and fixed artifact index select the recoverable bytes.

**Restore the entire source namespace into a temporary store.** Indexing selected references on disk avoids another copy of unrelated private canonical records and artifacts.

**Add a second archive parser or cryptographic envelope.** The canonical checkpoint container already verifies record footers, native references and recovery material.

**Publish repositories while checking later entries.** A missing pack or incompatible parent could otherwise expose a partially accepted recovery. All prepared graphs remain private until their complete validation finishes.

**Trust ordinary private-repository initialization to be empty.** Git can copy the Host's configured template. A real receiving-Host fixture exposed unrelated template objects and refs through the otherwise valid prepared repository.

## Consequences

Real independent-Home fixtures recover a 4 MiB plus 17-byte binary file, native/legacy refs, symbolic refs, CRLF HEAD and unclassified objects after deleting source caches. Stored fixtures remove live headers and replace the cache with another graph, then recover only the archived graph. Counterexamples cover cloned empty captures, another parent namespace, a genuine foreign namespace artifact substituted for a selected pack, missing bytes, actual pack-stream cancellation, incomplete and abandoned readers, and valid chunk checksums whose Git graph lacks the claimed tree. A real temporary receiving-user Git configuration cannot add template objects or refs. The byte primitive also rejects substituted and linked files.

Complete pack capture and validation require temporary disk proportional to captured Snapshot content; descriptor and inventory work stays bounded in memory. A segment is a physical Snapshot recovery unit, not proof of complete deployment backup, physical writer exclusion, current authorization, new deployment identity or paused publication. The joint operator must still supply those owners before allowing execution.
