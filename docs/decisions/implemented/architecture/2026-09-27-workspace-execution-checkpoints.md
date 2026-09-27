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

## Alternatives considered

**Release the native claim before uploading.** Another writer could alter the snapshot, causing the recorded operation outcome and durable files to diverge. Checkpoint capture, transfer and head publication stay within retained ownership.

**Keep inspecting a deleted native receipt.** Supervisor cleanup legitimately removes temporary process resources. Completion is verified before cleanup and carried in the coordinator's durable record instead of treating an absent receipt as proof.

**Return the last saved manifest when compute disappears.** That would hide unsaved changes. The active view retains its identity and fails until it can be reconciled.

## Consequences

Upload failures consume compute and writer occupancy until saving succeeds or explicit recovery resolves the operation. The single writable view excludes conflicting allocations. The file host has resource-local receipts and immutable staging objects but does not own Agent conversations or a second business database. Native, Unix, HTTP and TLS access share the same schemas and file implementation.
