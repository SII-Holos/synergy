# Decision Record: Reclaim acknowledged Executor payloads

Status: implemented

## Problem

Long-lived native and Docker Executors retain command output and Workspace checkpoint blobs after their durable consumers acknowledge saving. Per-command limits do not bound cumulative allocation storage. Deleting shared blobs without upload ownership can corrupt an independent checkpoint or an incomplete transfer.

## Decision

Execution release removes output chunks and process references after physical drainage and durable save acknowledgement. The small execution identity, digest and terminal receipt remains available for deduplication and restart. Cleanup retries use the same immutable identity.

Workspace blobs have explicit mount, checkpoint or execution retention owners. Owners hold hard links to immutable bytes; the last owner removes the shared name. A filesystem lock serializes retention and removal, and durable owner tombstones prevent delayed retries from repopulating released storage. Cleanup removes the shared name before its last retained link so an interrupted unlink remains discoverable. Retrying an old cleanup compares physical identity before touching a replacement object with the same content hash.

Execution protocol 3 requires retention identity on uploads. Completed materialization releases mount uploads, checkpoint acknowledgement releases before/after snapshots, and execution release drops its before-images. Small receipts remain, while payload size returns to the live retention set. Legacy unscoped blobs remain readable until the allocation is retired; native deallocation removes its owned execution directory. Protocol rollout drains old allocations before activation.

## Alternatives considered

**Increase temporary storage.** Delays exhaustion without fixing accumulation.

**Delete every blob on acknowledgement.** Can destroy bytes retained by another checkpoint, execution or concurrent upload.

**Collect blobs by age.** A slow or disconnected consumer still needs its retained bytes; elapsed time is not acknowledgement.

## Consequences

Clients and Execution Hosts advance together. Live and unresolved work retains its payloads; metadata is preserved for replay instead of using deletion to permit duplicate effects. Regressions cover shared and concurrent owners, interrupted cleanup followed by re-upload, restart, repeated release and native output reclamation. Existing unscoped cache reclamation requires normal physical retirement rather than a speculative online sweep.
