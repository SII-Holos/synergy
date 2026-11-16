# Decision Record: Install verified Snapshot history through native Home ownership

Status: implemented

## Problem

Preparing a Snapshot segment only reconstructs temporary repositories. Removing that staging directory leaves the restored SQL owners without canonical native history. Copying a healthy repository into another target does not establish who published it, and self-consistent segment counts cannot prove that the fixed source namespace's complete Snapshot partitions were retained. Stored owners also need their reconstructed graphs to share the target's canonical cache without changing their persisted backend.

## Decision

`SnapshotMaintenance.withInstalledSegment` is a trusted native installation operation. It requires the original open `HomeRestoration` permit, a permanent format-three Home marker, the complete original installation request, the fixed namespace archive and the independently verified Snapshot segment. The request's full namespace manifest hash and `payload.snapshot.manifestHash` bind the two archives. The complete request and all archive/key/signal ports are snapshotted before asynchronous work. A descriptor or hash alone cannot produce installation evidence. This owner does not create another installation intent or change its phase.

The canonical checkpoint reader verifies the actual fixed namespace and indexes its Snapshot formats, owners, content headers, legacy fences and history references in a private SQLite database. The existing Snapshot segment owner verifies and reconstructs the exact private Git closures. Before canonical publication, every non-deleted namespace owner and required root must be covered. Stored layouts require the archived `external-v1` format and the actual selected target persistence owner; a different backend is rejected rather than implicitly converted. Multiple stored retention graphs merge into that Scope's canonical cache. Native and legacy repositories retain all objects, ordinary and symbolic refs and exact HEAD, including unclassified objects and the legacy `.shared.old` pool.

The Snapshot owner supplies canonical destination paths. Installation rebuilds private sibling repositories with the existing empty-template initializer and Git object-transfer owner. Complete object identities, types and sizes are streamed in Git's deterministic hash order; refs are streamed in name order. HEAD and private configuration join the closure digest. Canonical verification rejects external alternates, linked entries, changed private configuration and incomplete or different object/ref inventories. It uses Git's own integrity checks instead of a second Git parser. Private metadata reads use bounded ordinary file descriptors.

Each published repository contains an immutable physical reference to its actual installation ID, original request, namespace, segment and complete closure. It has no independent phase or authorization. The marker is durably written before atomic sibling publication; target-parent synchronization completes publication. Cold retries rebuild and verify the original fixed graphs, require that exact reference and reverify the actual canonical bytes. An identical repository without this installation's reference is preserved and rejected. Imported pack protection remains conservative until the later actual namespace-adoption owner can retire it.

The real Snapshot Home lease spans preparation, native publication, the caller's final namespace transaction and verification. `SnapshotLease.withHome` passes only its actual retained token through the existing native admission context, allowing owning Scope readers to finish without waiting on their own Home lock. Another caller remains excluded. Escaped callback frames cannot use that inherited token; exceptions and cancellation dispose the native lease. The API refuses a storage transaction before waiting on physical ownership, preserving the Home-before-SQL lock order.

The installed result is opaque and bound to the original callback, Runtime, primary Store, artifact identity, Home permit and Snapshot lease. Its pure assertion can be consumed by an owning finalization guard; asynchronous verification rechecks the actual physical marker, directories, configuration and complete closure. Runtime closure and cancellation retain their original signal and drain through the same Snapshot owner. No descriptor can reproduce this evidence.

## Alternatives considered

**Treat prepared temporary paths as restored history.** The preparation owner removes them when its callback ends; SQL ownership would retain nonexistent data.

**Adopt any matching repository.** Content equality does not prove the target belongs to the original installation. An unrelated or copied target must not acquire native ownership from a caller label.

**Trust only segment totals.** A valid authenticated segment can consistently omit an entire repository while the namespace still references its owner.

**Convert stored graphs to native persistence.** That would disagree with the restored repository format and turn an implementation cache into a second content authority.

**Allow all Snapshot work to bypass the Home lease.** Only the actual callback's native parent token qualifies nested work. Independent writers and expired frames remain excluded.

## Consequences

Snapshot files can survive private staging cleanup and cold target reopening while remaining behind the permanent recovery fence. The operation does not create a ready receipt, change signing authority, release copied maintenance holds, establish old-writer retirement, reconcile current ACLs or resume a Session. The deployment coordinator still needs one typed aggregate request containing every fixed cohort/facet identity and each required owning publication receipt before enabling reads or execution. Fixture-only Snapshot requests do not expose a second product recovery entrypoint.

## Verification

`test/snapshot/restoration.test.ts` uses actual fixed protected namespace/segment archives, actual native Home installation permits and independent target Stores. It removes source native data, installs native, legacy and prior shared repositories, imports the namespace through its real transaction, reads canonical owners/retention and retries after a cold Runtime restart. It checks copied and expired evidence, different installation references, missing references despite identical content, a fully authenticated self-consistent segment missing a whole canonical partition, stored multi-retention graphs, cancellation and changed object closure. The stored owning-reader case first timed out while taking a second Home lease; the native callback composition resolves that actual self-wait.

`test/snapshot/lease.test.ts` retains existing cross-process, contention and abandoned-lease coverage and adds actual nested reads under a retained Home lease, foreign exclusion, transaction refusal, exception/cancellation cleanup and escaped callback rejection. Existing segment tests continue to verify pack/ref/HEAD integrity, fixed archived graphs, receiving-Host isolation, cancellation and incomplete consumption.

Git's all-object traversal contract is documented in [git-cat-file](https://git-scm.com/docs/git-cat-file#Documentation/git-cat-file.txt---batch-all-objects). Existing Snapshot initialization and transfer owners retain the authoritative upstream provenance for filesystem durability, private hooks and object publication.
