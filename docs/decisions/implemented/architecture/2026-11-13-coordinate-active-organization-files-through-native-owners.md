# Decision Record: Coordinate active organization files through native owners

Status: implemented

## Problem

An active Environment owns the physical file view. Updating a dormant object head misses those bytes, while bypassing native operation, checkpoint and Use owners can lose CAS, physical completion or an unknown acknowledgement.

## Decision

The Service file owner uses the actual mounted FileHost for listing and mutations. Writes and structural changes go through WorkspaceOperations, its original checkpoint and native Use. Current Workspace authority gates admission and the final asynchronous native dispatch. Already accepted physical saving and release retain their original native and Service-tail owners after observer cancellation or fresh human authorization disappears.

Current authority is re-read after the final awaited native mount inspection, immediately before dispatch. Original signed receipt and acknowledgement inspection uses its retained machine, Session, grant, generation, reference and operation family rather than fresh project visibility. That metadata-only authority cannot read file contents or admit another mutation; resource organization/project attribution still matches the canonical owner. See the [permission-boundary postmortem](../../../postmortem/0188-active-file-authority-crossed-the-final-inspection.md).

The existing FileReceipt key retains a pending result bound to the exact request digest before dispatch. Only the actual completed operation and original saved checkpoint establish completion. A lost acknowledgement after physical mutation is inspected through those owners; retrying the same request cannot repeat the physical write. Different request bodies or stale versions conflict. Read-only receipt inspection does not dispatch mutations.

WorkspaceOperations exposes a narrow publication inspection facade. The checkpoint journal remains private, and metadata inspection produces no installation or execution capability. No extra transport schema or business ledger is introduced.

## Alternatives considered

**Write the saved head while mounted.** It can replace newer active bytes with an unrelated dormant view.

**Publish a completed receipt after submitting a native request.** Submission does not establish physical completion or saved content.

**Retry CAS without retaining the pending receipt.** A successful physical write may already have advanced the version before its acknowledgement was lost.

**Require fresh human authority for accepted saving and release.** This can abandon the original native tail after its effect has already happened.

## Consequences

Shared active files retain native versions, CAS and original receipt recovery. The actual NativeExecutor/FileHost case covers list, write, read, directory creation, stale versions, conflicting request reuse, lost write acknowledgement and short-Use drainage without a second allocation or write. Full cross-Runtime and Handoff acceptance remains separate from this owning-domain case.
