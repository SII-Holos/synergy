# Decision Record: Attach paged Workspaces through verified archive copies

Status: implemented

## Problem

The native FileHost could materialize a paged saved head, but Harness attachment still required a complete legacy manifest before invoking it. A valid object-backed Workspace therefore failed during attachment. Rebuilding a complete manifest would restore the growing arrays the paged format removes.

## Decision

Object attachment selects the original Workspace revision through `WorkspaceArchive.saved`. The archive owner copies the saved graph through its existing record producer, binding the original destination method before asynchronous work. The producer verifies the complete referenced object closure and each file digest; only its completed stream permits publishing the descriptor to the destination. Original Runtime/storage ownership and cancellation remain checked after destination writes.

`WorkspaceMounts` passes that verified descriptor to the existing FileHost mount request. The original canonical mount, retained Environment Use, native preparation identity and acknowledgement reconciliation remain responsible for authority. Copying immutable objects creates neither a Workspace nor another transfer receipt.

## Alternatives considered

**Reconstruct a legacy manifest.** Complete entry and per-file chunk collections would reintroduce the old memory limits.

**Decode and copy the paged graph inside Mounts.** The archive already owns complete graph enumeration, object verification and completion. Another decoder would duplicate those rules.

## Consequences

Attachment accepts both saved-head formats through one copying owner. Native checkpoint capture and later save keep their explicit existing format and are separate producer work. Failed copies can leave unreferenced immutable objects; they cannot publish a completed descriptor or authorize an unrelated native directory.

## Verification

Local Runtime `test/workspace/mount-paged.test.ts` attaches a real multi-page saved head, deletes all original object files, reads from the native mount, then detaches through its original checkpoint owner and reads the saved bytes. Native mount maintenance and operation suites retain receipt, conflict and drainage coverage. Harness archive tests verify captured destination methods, original saved-selection identity, foreign Runtime rejection and refusal to publish a descriptor for a wrong complete-file digest. See [the postmortem](../../../postmortem/0132-paged-workspace-attachment-used-a-legacy-parser.md).
