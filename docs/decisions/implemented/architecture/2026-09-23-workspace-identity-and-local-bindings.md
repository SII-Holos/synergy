# Decision Record: Workspace identity and local bindings

Status: implemented

## Problem

A directory string cannot identify working files independently of their location. Concurrent registration, moving a directory, importing another host's history, and reusing a former pathname require distinct outcomes.

## Decision

The Harness Workspace catalog owns stable identities and transactional location indexes. Each local binding names a host namespace, path, optional filesystem identity, and generation. Rebinding requires the expected record revision, preserves the Workspace ID, and advances its binding generation. A conflicting destination or replaced directory requires an explicit operation instead of silently adopting different files. Cross-Scope lookup is unavailable to callers.

Runtime hosts explicitly supply local location identification. Runtime Local uses a persistent private namespace identity and filesystem directory identities; hosts without local file capabilities can omit that dependency. A record revision orders metadata changes, while a binding generation invalidates work resolved against a previous location.

OverlayFS directory copy-up changes the backing layer's birth time without replacing the visible directory. On that filesystem, directory identity uses the overlay device/inode pair; other local filesystems retain the birth-time discriminator. The Workspace catalog and native exclusion coordinator share this implementation. A real container regression reproduces the first child creation changing birth time while the directory identity remains stable.

Provenance: [Linux OverlayFS directory metadata and copy-up](https://docs.kernel.org/filesystems/overlayfs.html#directories). Local adaptation: do not mistake backing-layer metadata replacement for user-visible Workspace replacement. Mount or inode changes still require explicit rebinding.

Sessions persist a nullable Workspace ID and hydrate public directory descriptors through the catalog. On-access owner migrations apply before navigation validation, with a new derived-index repair for already-completed historical index migrations. The Runtime initializes its namespace outside retryable storage transactions. Hosts without filesystem capabilities preserve historical bindings as unbound records.

Selecting current preserves an absent Home Workspace and an unresolved historical reference. Selecting none explicitly clears the reference. Route regressions and the real plugin composer verify that a Home conversation can reach its provider without acquiring local file authority.

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

File streaming owns its native descriptor and binding use claim independently of the request handler's task. Deferring file opening until body consumption could return a replacement file after the request had already resolved. The stream now opens and validates the file before returning, reads only on demand, and closes on EOF, cancellation, request abort or Workspace disposal. Tests cover atomic pathname replacement, unread streams, partial reads, truncation and empty files.

Directory-entry operations share the native Workspace writer gate while distinguishing entry identity from content evidence. The final symlink is not dereferenced for move or deletion. Copy publishes a verified staging tree through the platform's exclusive rename; cross-device moves report partial completion if source removal fails. APIs and the Explorer capture the same observed entry version, preserve form input on errors and keep dirty drafts at their original paths. Permanent deletion is explicitly identified to the user.

Native watcher deletion/creation pairs no longer imply a rename. Such a guess can attach an editor to an unrelated sibling file, especially while atomic writers use temporary names. Explicit move results retain the rename event; all other filesystem observations invalidate their own paths. A browser regression preserves both source and destination drafts when a confirmed rename arrives.

Filesystem verification includes stale source selection, occupied destinations, parent-directory replacement, changed descendants, cancellation, read-only staging cleanup, external and dangling symlinks, protected recursive contents and an actual mounted filesystem for cross-device movement. Route and browser tests cover generated request shapes, conditional failures, captured Workspace generations, localization and focus return.

Provenance: [Apple exclusive rename flags](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/stdio.h), [Linux renameat2](https://man7.org/linux/man-pages/man2/rename.2.html), and [Windows MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw). Local adaptation: use the native no-replacement operation for directories as well as regular files instead of a racy existence check followed by ordinary rename.

Snapshot capture includes bound non-Git directories and keys disposable indexes by Workspace and binding generation. New snapshot parts retain their source binding, while summaries group each source separately so same-named files remain distinct. Historical comparisons use the retained Scope object store without requiring a live directory. Legacy parts remain unattributed instead of inheriting the current binding. The versioned derived summary cursor rebuilds from canonical parts.

Provenance: [Git NUL-delimited diff output](https://git-scm.com/docs/git-diff) and [literal tree metadata](https://git-scm.com/docs/git-ls-tree). Local adaptation: separate literal filename records from rendered patch headers and read object sizes through tree metadata rather than newline-delimited filename interpolation. Tests cover non-Git capture, unusual filenames, deleted local directories, generation-specific indexes, separate summary ranges, and browser review of same-named files.

Binding lookup must not eagerly import Workspace startup and Session execution. Loading the resource disposer at the rebind operation preserves the Agent worker's static module boundary and prevents permission and Rollout schema initialization cycles. The worker graph and isolated permission processes verify this dependency direction.

Historical file restore uses a native Host rather than Git checkout into the current directory. The Harness prepares verified retained objects with original binding provenance; Runtime Local captures entry and content evidence before waiting, pins all source bindings, reserves all affected roots, and applies conditional entry replacement. A changed later file produces a per-file failure while earlier completed work remains explicitly reported. This accepts observable partial results instead of claiming cross-filesystem atomicity. Restoring a link replaces the link entry without following its target. The Session execution lease remains occupied through cancellation and cleanup.

Transfer inventories include historical step, snapshot and patch sources, message summaries and Session diffs. Imported IDs are remapped consistently to unbound catalog records with original identity metadata, including when the uploaded ID already exists locally. Missing location metadata remains a null historical path with no projected execution directory. Rebinding cannot reinterpret a captured historical generation. Native tests exercise queued newer writes, missing bindings, external parent links, exact binary and BOM bytes, hard-link aliases, executable bits, symlink text, multiple Workspaces, newly created files, cancellation and Session loop drainage. Transcript fixtures cover equal existing IDs and missing catalog metadata.

An in-flight Session switches bindings through its Workspace task, not a generic Session editor. The task validates the caller's generation, pins the destination, prepares native resources, persists the selection and then transfers its context and logical claims. Parallel admitted operations reject switching; an independently owned process keeps its original binding until exit. Failed persistence or cancellation preserves the previous selection. An unavailable old directory can still be left. Child creation and forks preserve unresolved references. Real Session regressions cover each boundary, including rebind after selection and ordinary editor bypass.

Starting destination resources also exposed the managed-worktree janitor taking removal gates for read-only eligibility reporting below its cap. Those probes now leave the removal gate available; actual reclamation still rechecks under the gate. Native and Product Runtime tests exercise reporting alongside live worktree transitions.

The former PTY dependency decoded each native chunk independently, so a real multilingual-output regression produced replacement characters. Its unbounded native queues and child-exit marker also could not establish complete stream drainage. Runtime Local now builds a pinned portable-pty byte transport with bounded input/output channels, explicit argv/environment, EOF drainage independent of root exit and version-checked FFI. macOS PTYs reuse independently supervised native process trees, keeping Workspace binding and writer claims after browser disconnection and detached-child execution. Scope listing remains an index; Workspace generations own native cleanup. The source preparation, module packer, binary assets, generated API and Web terminal state carry the same contract.

Provenance: [bun-pty 0.4.4](https://github.com/sursaone/bun-pty/blob/v0.4.4/rust-pty/src/lib.rs) and [portable-pty CommandBuilder](https://docs.rs/portable-pty/0.8.1/portable_pty/cmdbuilder/struct.CommandBuilder.html). Local adaptation: retain portable-pty 0.8.1, replace the string/chunk bridge with bounded byte streams, and keep native tree ownership separate from PTY EOF. Both upstream MIT notices ship with the library. Native tests exercise split UTF-8, an 8 MiB paused producer, exact argv/environment/cwd, rejected launch, excessive input, slow clients and detached descendants.

Native macOS tests contribute their measured coverage to the same aggregate gate as Linux tests. The native shard injects an isolated test home before Bun starts and preserves repository-relative artifact paths; the aggregate waits for it. The PTY module is no longer exempt from coverage. Type-only process contracts, independently executed workers and Chromium-only UI code retain narrowly documented exclusions because Bun cannot instrument those execution locations from its parent test process.
