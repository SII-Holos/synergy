# Decision Record: Lossless legacy snapshot compaction

Status: implemented

## Problem

Registering legacy snapshot owners does not consolidate their object stores. Repeated project baselines continue consuming disk space across sessions, and loose-object allocation can exceed logical content size. Starting ordinary maintenance may require a SQL upgrade whose immutable backup needs that same free space. Migration also spawns a process per tree and flushes each new retention reference separately, making a large backlog expensive to process.

## Decision

An explicit, dry-run-first legacy pack operation works directly on artifacts before SQL initialization. It streams local loose object IDs into a temporary SQLite inventory, packs all of them including unreferenced objects, verifies complete coverage against that disk inventory, flushes pack data and indexes, and only then removes duplicate loose copies. Packs are verified in staging before publication so corrupt output cannot contaminate a repository or a retry. It preserves existing packs, alternates and session ownership. Exclusive process ownership and Scope leases exclude writers. An interrupted backup blocks changes to its source inventory.

Shared migration remains the canonical way to remove cross-session duplication. A session filter covers both owner registration and migration, progress reports completed repositories, and batch tree verification removes per-tree process startup. Migration stages retention references without individual reference flushes, then asks Git to write a flushed packed-ref file while retaining loose copies. After explicitly syncing that file and its parent directory, Git removes duplicate loose refs. Git before 2.36 does not support reference fsync; on that narrow compatibility path migration explicitly flushes and retains loose refs instead of rewriting previously packed history. Only then can the existing durable journal switch the owner and clean the source. Other transfer callers retain their existing reference publication behavior.

The object algorithm follows [Git pack-objects](https://git-scm.com/docs/git-pack-objects), [verify-pack](https://git-scm.com/docs/git-verify-pack) and [prune-packed](https://git-scm.com/docs/git-prune-packed). Reference durability follows [core.fsync in Git 2.36](https://git-scm.com/docs/git-config/2.36.0#Documentation/git-config.txt-corefsync) and Git's [packed reference writer](https://github.com/git/git/blob/v2.50.1/refs/packed-backend.c). The [2.25.1 writer](https://github.com/git/git/blob/v2.25.1/refs/packed-backend.c) replaces packed refs even for unchanged values without a file flush. The local adaptation retains the legacy source and import protection until publication finishes.

## Alternatives considered

**Delete old or unreferenced snapshots.** Age and current transcript visibility do not prove that retained history is disposable. All object identities and historical roots are preserved.

**Run ordinary Git GC on every legacy repository.** Unreferenced objects can be pruned and duplicated baselines still remain across sessions. The packing operation explicitly enumerates all local loose IDs and does not prune history.

**Require SQL activation before any space recovery.** This creates a capacity dependency when the upgrade backup cannot fit. Artifact-only packing does not need a second legacy record writer.

**Disable reference durability globally.** This could publish shared ownership without crash-safe history. Only staged migration reference writes defer their flush, and packed publication precedes ownership changes.

## Consequences

Packing temporarily needs room for one repository's pack and does not remove duplication between separate repositories. Shared migration still pays for complete integrity checks and source cleanup. Physical space reduction must be measured on the filesystem, independently of estimates returned by packing. Interrupted verification/publication keeps the source and supports retries. Tests compare full object inventories, historical reconstruction, alternates, packed refs and durable migration checkpoints; process interruption tests do not establish universal power-loss guarantees.
