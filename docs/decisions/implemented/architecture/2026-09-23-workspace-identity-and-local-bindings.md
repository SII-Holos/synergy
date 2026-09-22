# Decision Record: Workspace identity and local bindings

Status: implemented

## Problem

A directory string cannot identify working files independently of their location. Concurrent registration, moving a directory, importing another host's history, and reusing a former pathname require distinct outcomes.

## Decision

The Harness Workspace catalog owns stable identities and transactional location indexes. Each local binding names a host namespace, path, optional filesystem identity, and generation. Rebinding requires the expected record revision, preserves the Workspace ID, and advances its binding generation. A conflicting destination or replaced directory requires an explicit operation instead of silently adopting different files. Cross-Scope lookup is unavailable to callers.

Runtime hosts explicitly supply local location identification. Runtime Local uses a persistent private namespace identity and filesystem directory identities; hosts without local file capabilities can omit that dependency. A record revision orders metadata changes, while a binding generation invalidates work resolved against a previous location.

Sessions persist a nullable Workspace ID and hydrate public directory descriptors through the catalog. On-access owner migrations apply before navigation validation, with a new derived-index repair for already-completed historical index migrations. The Runtime initializes its namespace outside retryable storage transactions. Hosts without filesystem capabilities preserve historical bindings as unbound records.

Transcript and Rollout exports include the referenced catalog records. Imports retain their historical locations but mark bindings unbound and discard shared-write grants. If the original identity is already bound locally, import creates a separate historical identity so an uploaded transcript cannot authorize file access.

## Alternatives considered

Deriving Workspace IDs from absolute paths would change identity on a move and conflate equal paths on different hosts. Keeping a path in every Session would leave multiple mutable owners of the same binding. Neither supports an atomic destination uniqueness check.

## Consequences

Working-file resources are keyed by Runtime, Workspace ID and binding generation. The startup registry declares Scope or Workspace ownership, and Scope steps cannot depend on Workspace steps. Configuration subscriptions keep their Scope owner. Native file notifications, formatter subscriptions and VCS notifications carry and filter Workspace identity, while the Scope bus retains its event sequence.

LSP process recovery verifies host, owner process identity and child process identity before signaling an orphan. Concurrent registrations use one locked, atomic process ledger; per-client release tokens prevent an earlier client from removing another record. PID-only historical files cannot establish authority to signal a process. Starting another Workspace must leave active language servers alive.

Local bindings and their indexes are persisted separately from Session history. Consumers must resolve an explicit Workspace and retain its generation for execution. A directory that is missing or has been replaced cannot be made usable merely by finding another directory at the stored pathname.

File API requests carry an explicit Workspace and generation. Open file tabs retain their owner across session selection and rebinding; server-side generation validation is also applied to raw document assets. Scope and Workspace caches remain separate so same-named files cannot alias across directories.

File content versions are independent of catalog revisions and binding generations. Native writers use exact-byte SHA-256 evidence and atomic replacement under a shared canonical-path lock. Timestamps cannot prove unchanged content; editor drafts retain their initial evidence across refresh, while agent tools revalidate after approval. The anchored patcher keeps display normalization separate from the BOM and line-ending bytes written to disk.

## Verification

Resource tests interleave Workspace startup, shared Sessions, rebinding and Scope disposal. Runtime Local tests exercise separate real Git directories, bounded file indexes, native watcher delivery, nested Workspace paths and whitespace in filenames. Formatter tests launch real subprocesses and verify one execution per edit across multiple Workspace subscriptions.

Catalog tests exercise concurrent registration, host separation, generation rejection, cross-Scope lookup, and stale conditional updates against real SQLite. Filesystem tests verify persistent namespace convergence and directory replacement with real temporary directories.

Session tests cover shared parent/child references, rebinding, null workspaces, canonical writes, unbound transcript imports, Rollout archives, unknown owner data, old metadata, navigation repair after restart, deferred-owner isolation and transaction rollback. Runtime Local tests remove a historical directory before reopening and verify that metadata remains readable while execution fails.

Server route tests use two real directories in one Scope, Home-owned Workspaces, cross-Scope references, stale generations, removed directories, and raw relative resources. Browser tests hold an old read response across Workspace selection, verify independent cache recovery and watcher filtering, and retain the generation of a captured file handle.

File tests cover preserved timestamps, approval-time drift, cancelled lock waiters, two native processes competing for one version, changed parent symlinks, external hard links, executable modes, BOM/CRLF, and binary byte preservation. Browser tests cover dirty baselines after refresh, Workspace switching, edits made during a pending save, and coalescing watcher bursts.

Workspace write reservations belong to whole Session turns, with independent claims for active mutations and native processes. Per-file locks alone cannot preserve a multi-file task's view. Native overlap includes ancestor paths and resolved filesystem identities across Runtime instances; host-wide execution is represented explicitly rather than inferred from command text. The coordinator's process identity check deliberately preserves uncertain ownership instead of releasing on age.

Tool and Cortex capacity is relinquished while waiting for a Workspace. Parallel tools use separate activity branches so one waiting tool cannot release capacity still used by another. Cortex parent handoff drops the turn reservation before child admission or output waiting, while physical operations retain their own claims. This avoids capacity exhaustion caused by tasks that cannot perform work, at the cost of revalidating binding and cancellation after every resume.

Coordination tests use real temporary directories and child processes. Session and Cortex integration tests cover same-Workspace write ordering, disjoint work, parent-child handoff, one-slot capacity, parallel tool branches, cancelled waiters and post-admission cancellation. Scheduler tests verify that queued work retains its dispatch context and nested plugin tools relinquish borrowed capacity together.

Write authority follows the selected Workspace and its direct explicit shares, rather than Scope folder membership or Skill installation. Sharing changes metadata revision without changing binding generation. A native use claim pins each shared binding for the turn; rebind and sharing updates exclude active users before committing their catalog change and sequenced event.

Native sandboxes report compiled writable roots, including Linux's host-backed temporary mount. macOS removes implicit shared-temp write grants and resets imported OS file-write grants before emitting its own path allowances. A missing bounded receipt, the legacy macOS profile, and the Windows helper require host-wide exclusion. This accepts conservative serialization when the backend cannot establish a complete host footprint; inferring roots from cwd or a command classifier would incorrectly allow overlapping writers.

Native sandbox verification exercises real external-write denials, explicit shared writes, read-only mode, controlled temporary files, credential denials and Keychain service availability. API tests cover conditional sharing, rebinding, stale generations, Session selection and clearing the binding.

Workspace selection, direct sharing and rebinding are exposed in the existing Session controls. Frontend Scope snapshots include catalog records, and sequenced catalog events reproject Session bindings without changing activity timestamps. Generation guards also apply to delayed Session reads. Existing file tabs keep their original binding; unbound or retired projections cannot open local files. Conditional form submissions retain the revision observed when editing began.

Browser verification uses real dialog, checkbox and focus behavior to exercise busy failures, conditional sharing, directory registration, explicit historical rebinding and Escape focus restoration. Snapshot/event race tests apply a rebinding event before an older bootstrap response and verify the new Session projection alongside the original pinned file descriptor.

Process admission represents binding use separately from the compiled write footprint. A read-only process pins its Workspace against lifecycle changes without taking a writer reservation; host-wide writers conflict with every nonempty write footprint, not with an empty set. Real child-process tests verify both concurrency and rebind exclusion through process exit, and Harness tests verify the receipt's exact roots survive admission.

macOS Bash now launches a passive worker in an independent launchd resource coalition and binds its durable claim before activation. The coalition's atomic task counters, paired with the host boot identity, establish completion through empty-environment double forks, new sessions and supervisor death. PID enumeration is used only to signal verified members, never as the emptiness proof. Source and compiled workers use the same private stream protocol and start without opening global storage. Runtime disconnect triggers owned-tree cleanup; ordinary nonzero exit, failed activation, cancellation and output drainage remain distinct outcomes.

Provenance: [Apple XNU process inspection](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h) and [coalition resource counters](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/sys_coalition.c). Local adaptation: Synergy retains Workspace ownership using the coalition and boot pair instead of shell parentage, environment tags or inherited pipe lifetime. A launchd worker uses its own OS permission identity; adding a marker sandbox to unconfined execution was rejected because it prevents later sandbox installation by the command.

Native tests cover preactivation fencing, exact binary streams, absent executables, empty-environment detached descendants, supervisor death, Runtime crash, cancellation with an unread full pipe, and real compiled read-only/disjoint/shared write footprints. Registry liveness consults the native tree owner so a dead shell PID cannot prematurely settle a running descendant.

Native claims retain the physical identities of each root's ancestors as well as its own identity. This preserves overlap when an external actor renames an occupied directory and another Runtime requests a descendant under its new pathname. Shared ancestors alone do not cause conflicts. A real rename regression verifies the moved descendant remains excluded until the original writer releases.
