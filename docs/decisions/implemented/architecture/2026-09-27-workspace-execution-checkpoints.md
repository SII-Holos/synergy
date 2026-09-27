# Decision Record: Retain execution ownership through Workspace checkpoint publication

Status: implemented

## Problem

A successful process can leave its only output files in a disposable container. Saving after releasing the physical writer permits another command to change those files before capture. Retaining a writer also requires completion evidence to outlive the native supervisor's cleanup.

## Decision

Workspace attachment records a separate mount generation and the exact Environment allocation. The Executor exposes a file host that materializes immutable objects, performs bounded file operations, and captures checkpoints under retained physical ownership. Harness execution records carry the selected mount references before dispatch. Their default completion path uploads all checkpoint objects and publishes the transactional Workspace content head before acknowledging and releasing ownership.

The physical coordinator verifies native process completion while its platform evidence still exists and persists that result in its host-local version 3 ledger. A durable writer remains occupied after that proof until the save acknowledgement. Runtime restart, process age and transport closure cannot substitute for the proof. The completed receipt permits explicit release after native supervisor cleanup, including on Linux where the subreaper receipt is temporary.

Environment resource owners drain Workspace views before provider deallocation. A final checkpoint and fenced detachment precede deletion of allocation-owned staging volumes. User-supplied directory and volume storage has independent ownership and is preserved. Save failures retain uses and writers; retries save the completed operation rather than execute it again.

The common process facade binds stream completion to this durable completion path. Physical exit remains observable, but presentation drainage cannot complete a command while checkpoint publication is pending. An explicitly empty compiled write footprint skips Workspace publication; nonempty footprints retain the complete selected root. Target runtime descriptions supply execution paths and shell settings without forwarding controller credentials.

Interactive terminals and user shell commands share the durable process facade. A terminal transport disconnect is a presentation event and leaves physical ownership intact. Explicit detachment retains the same identity through checkpoint failure and acknowledgement retry; a directory rebind must finish detachment before changing the physical binding. Logical Workspace cache selection does not require a local directory projection.

An indexed set of unfinished operations makes startup recovery independent of conversation replay and bounds periodic maintenance by active work. A versioned migration creates this index for existing execution records. The Runtime drains maintenance before closing process and Workspace owners. A confirmed lost live view remains unavailable even when a committed manifest exists, because restoring that manifest would silently discard later writes.

Mounted file writes use the same intent-before-dispatch ordering. Their core operation record carries the immutable write input, digest, view generation and allocation target. Recovery only resumes a known receipt, and cannot repeat a mutation after uncertain effects. Admission becomes durable in the same transaction as its owning intent so a crash before dispatch does not strand an unowned use.

Directory creation, copy, move and removal use the same operation record and checkpoint acknowledgement. The file host records completed mutation effects before capturing the tree, so an interrupted capture retries saving without changing files again. Uncertain partial effects retain ownership. Dormant object operations upload immutable data before publishing their content head and completed operation record in one SQL transaction; they allocate no execution resources. Entry versions fence tree mutations, and destination publication never overwrites an existing entry.

The file workbench resolves physical aliases at the execution host and carries protected-path enforcement into the admitted mutation. Controller preflight alone cannot protect a directory whose descendants change before admission. A known pre-effect rejection releases its durable use immediately and preserves its structured failure for identical retries. Transport errors without a confirmed rejection retain the original recovery rules.

File history records immutable before/after manifests under physical admission, including every mounted view covered by an execution write footprint. Evidence references belong to durable operations and can finish after a save failure or controller restart. Snapshot storage retains its existing Git object format while logical Workspace-relative paths survive allocation relocation. Restore uses conditional file operations, preserving multi-Workspace attribution even when names match. A failed history publication retains execution ownership instead of reporting a complete write with missing evidence.

Language servers hold durable Environment executions instead of controller process claims. The Executor exposes cooperative contention in operation status so an idle client can retire without interrupting active queries. Unchanged status observations do not rewrite Agent Storage. Explicit commands avoid importing native installers or controller paths into a remote allocation; the same file view supplies protocol document contents.

Formatter commands carry canonical file and byte-version preconditions to the Executor. Checking after physical admission prevents a queued formatter from overwriting a foreign edit. Confirmed failed process launches remain eligible for saving; a failed command alone is not evidence of uncertain physical completion.

Workspace services start from catalog identity and binding generation, including logical backends without a controller directory. The Executor observes its own mounted tree and exposes a bounded epoch/version cursor; restarting a subscription changes its epoch. File panels poll existing views without acquiring Environment uses or allocating compute, invalidate their caches on catalog or observation changes, and drain polling on Workspace disposal. Catalog head and mount changes increment the same revision and publish committed events. Branch discovery uses the selected Environment and resynchronizes after view changes.

Plugin Host callbacks carry the invocation's canonical resource selection across IPC and resolve each current file view without replacing its binding generation. Shell calls use the common Environment process path and prepare containment before policy evaluation. Native file-host claims inherit the caller's logical reservation, but retain their own durable physical writer; otherwise a completed shell's task reservation would deadlock a following file mutation in the same invocation. Remote execution hosts continue to own their physical admission without Agent task state.

## Alternatives considered

Product resource profiles snapshot storage locations and execution settings into their existing durable records. Composition registers provider factories before sealing; loading configuration never mutates the provider registry. Only secret references remain indirect so credentials can rotate independently of storage identity. The resource domain is global-only and fails closed: quarantining an invalid remote default into empty configuration could otherwise choose the native host. Uncoordinated external Docker mounts are read-only; mutable Workspace views retain one writer and checkpoint owner.

**Release the native claim before uploading.** Another writer could alter the snapshot, causing the recorded operation outcome and durable files to diverge. Checkpoint capture, transfer and head publication stay within retained ownership.

**Keep inspecting a deleted native receipt.** Supervisor cleanup legitimately removes temporary process resources. Completion is verified before cleanup and carried in the coordinator's durable record instead of treating an absent receipt as proof.

**Return the last saved manifest when compute disappears.** That would hide unsaved changes. The active view retains its identity and fails until it can be reconciled.

## Consequences

Upload failures consume compute and writer occupancy until saving succeeds or explicit recovery resolves the operation. The single writable view excludes conflicting allocations. The file host has resource-local receipts and immutable staging objects but does not own Agent conversations or a second business database. Native, Unix, HTTP and TLS access share the same schemas and file implementation.
