# Decision Record: Capture remote file lease inputs before deferral

Status: implemented

## Problem

`WorkspaceFileSource` tracks accepted file work until its lease closes, but the operation wrapper deferred reading caller-owned inputs to a microtask. A caller could change a path, nested Workspace reference or mutation after receiving the Promise. The native provider would then receive a different operation. Blob buffers also retained mutable caller storage.

## Decision

The existing lease operation owner captures structured request values synchronously before scheduling provider work. Object inputs retain their original nested references and mutation details. Blob writes copy the selected byte range to an independent `Uint8Array`, including when the caller supplies a Buffer view over shared memory. Observation signals keep their original identity and cancellation behavior.

The original provider admission, Runtime/Store checks, pending-work drainage and inspection-only restrictions remain in the same wrapper. Receipt formats, operation IDs, CAS rules and cold recovery do not change. See [owned remote file sources](../architecture/2026-11-12-route-dormant-remote-files-through-owned-workspace-sources.md).

## Alternatives considered

**Require callers to freeze their own inputs.** The public lease accepts ordinary mutable DTOs and byte arrays. Tool parsers often make a fresh request, but that does not establish the public port's contract for other callers.

**Copy only top-level request fields.** Nested mount identities and mutation details would remain mutable. Copying a typed array through structured clone can also retain a shared-memory backing store, so byte writes require their own independent copy.

## Consequences

Each accepted operation allocates a request snapshot; blob writes allocate only their selected byte range. The real NativeWorkspaceFiles fixture changes write/read requests, nested copy inputs and a shared Buffer immediately after invocation, then verifies the original disk effects and bytes. Existing ordinary-tool and cold receipt tests retain their lifecycle coverage. The defect and regression are recorded in [the postmortem](../../../postmortem/0152-remote-file-lease-used-mutated-call-inputs.md).
