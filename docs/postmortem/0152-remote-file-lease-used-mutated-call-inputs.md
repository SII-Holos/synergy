# Remote file lease used mutated call inputs

## Executive summary

A direct remote file lease caller changed its write request immediately after invocation. The real native host received the changed Workspace generation and rejected the operation. Other mutations could similarly replace the selected path or bytes before provider dispatch.

## Summary

The generic lease wrapper retained accepted Promises for shutdown drainage. It scheduled each native call with `Promise.resolve().then(...)`, while the callback still referenced the caller's original mutable request or buffer.

## Timeline

Review identified the deferred-input boundary. A regression invoked a real remote file lease, changed the nested mount generation synchronously, and observed `Workspace mount changed` instead of the original write. Capturing inputs before deferral made the same native test pass. Its read-range fixture initially omitted the required offset; correcting that fixture followed the existing read contract and did not change production behavior.

## Root cause

Promise ownership did not establish input ownership. The wrapper admitted one call but read its arguments later. Existing tools generally passed fresh parsed DTOs, so their integration coverage did not expose direct public-port mutation. Shared-memory typed arrays also require an independent byte copy rather than a structured clone alone.

## Resolution

The same operation wrapper synchronously clones structured inputs before scheduling provider work. Blob writes copy the selected range to independent bytes. Opaque AbortSignals retain their original cancellation identity. Provider selection, original lease authority, operation receipts, CAS and cold inspection remain unchanged.

## Guardrails

The native fixture mutates write paths/data/references, read paths/limits/references, nested copy details and a Buffer view over shared memory immediately after invocation. It verifies the original files and blob contents through the actual host. The original ordinary-tool and cold lost/absent receipt tests continue to run alongside it.

## Lessons

Capture mutable values at the public asynchronous call boundary, before any microtask or wait. Retaining a Promise is separate from retaining its original request. See [the decision](../decisions/implemented/bug-fix/2026-11-12-capture-remote-file-lease-inputs-before-deferral.md).
