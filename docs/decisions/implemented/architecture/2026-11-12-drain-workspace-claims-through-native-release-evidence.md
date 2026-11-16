# Decision Record: Drain Workspace claims through native release evidence

Status: implemented

## Problem

Canonical Workspace mutation receipts do not cover every direct file, metadata, process or retirement claim. A task can return while its process lease remains active, and physical release can precede an asynchronous final save. New raw claims must not enter after maintenance has inspected its writers. Conversely, a file checkpoint acknowledgement can recover and release the same physical claim through another lease object, leaving an original in-memory waiter unresolved.

## Decision

Selecting the Workspace access Host registers one `workspace-access` maintenance contribution. Every non-read claim enters its actual pending lifetime before asynchronous admission, checks the current maintenance operation before native acquisition, and rechecks after acquisition before returning control to an effect. A rejected late admission releases the same physical lease. Binding pins remain nonexclusive reads.

Accepted physical claims remain tracked through their actual release and native finalizers, including `afterRelease`. Process leases can outlive their originating task. Process binding and writable lease operations retain their Runtime and Store identity. No new execution grant or canonical mutation bypass is introduced.

The current accepted mutation, retirement or finalizer can finish its original tail while the operation is draining. This authority is a private callback scope with an explicit open lifetime, independent of the retained claim's reconciliation state. Its `finally` closes admission on success or failure. Escaped asynchronous callbacks cannot use a failed but retained claim to open a new exclusive writer. Unknown cleanup or recording failures remain blocking instead of turning into successful drains.

The native coordinator supplies `isReleased` from the exact original ledger ID and token. A resolved release call can leave an active process retained. The original token can instead be released by another native lease recovered from a canonical receipt. Maintenance rechecks that physical evidence while waiting, preserving asynchronous finalizers and failures separately. A replaced identity fails closed. This uses the existing physical ledger and canonical receipts; no parallel persisted operation table or RAM-only completion authority is added.

## Consequences

Cancelled maintenance waits preserve the original writer and lease. The same operation can retry after the actual release or save reconciles. Physical Hosts supply an exact release predicate; native ledger polling does not authorize replacement execution. Callback lifetime records are Runtime-local, while existing canonical receipts and the physical ledger retain durable authority. No persisted schema migration is needed. Mount transitions, resource capture and complete deployment writer reconciliation remain separately owned.

## Alternatives considered

**Track tasks until their callbacks return.** Process leases can outlive the task, and finalizers can continue after the physical claim is removed.

**Trust the original release promise alone.** Native release can defer while a process lives, and canonical receipt recovery can release a different lease object.

**Keep failed callback authority while its claim remains retained.** An escaped callback could then start another physical effect during drainage. Reconciliation does not authorize execution.

**Freeze lower Environment acquisition.** Accepted native checkpoint acknowledgements and final saves still need their original Environment owner.

## Verification

Harness temporary Runtime/SQLite fixtures first reproduce admission through all six raw mutation entries, premature drain completion, a process lease outliving its task, an escaped exclusive callback from failed saving and cross-Runtime/Store binding. They verify actual file effects, cancellation, finalizer completion and original claim lifetime. Capacity cancellation and existing Workspace operation tests remain selected.

Local Runtime fixtures use the real physical coordinator. A claim admitted across a hold is released before its first file effect; an unacknowledged release remains held until that original lease completes. Existing real native file tests exercise committed writes with lost acknowledgements and recovery-based release without replay. Native process, output and retained-ledger regressions remain selected. These tests do not establish complete deployment backup or restored execution authority.
