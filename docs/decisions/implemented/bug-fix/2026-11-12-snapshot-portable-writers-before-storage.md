# Decision Record: Snapshot portable writers before storage

Status: implemented

## Problem

A portable writer repeatedly read the caller's cancellation and retained nested metadata by reference. Removing an aborted signal during an accepted object write let the writer return a completed root. Mutating a nested key or metadata object while a chunk write waited changed the eventual entry identity metadata. Validation through `JsonValue` did not provide a deep copy. A pre-cancelled writer also started its producer before checking admission.

## Decision

Both content writing and reference composition capture the original signal, bound blob methods and owner versions at invocation. Each entry's validated metadata is copied through its JSON representation before any chunk await. Cancellation is checked before producer admission and on both sides of accepted storage writes; cancellation retains its original reason and does not undo already written immutable objects.

`SessionTransferStream.link` composes existing content references through the same entry-page and chunk-page writers used by normal content export. The indexed reader exposes bounded ordered chunk references. Composition validates chunk sizes and totals without reading or copying their bodies. Callers retain the original content store and retention responsibility. Metadata composition does not establish content verification, copy content to another store, publish a Workspace head or supply execution authority. Readers still verify selected chunks and complete-file digests under their existing rules.

## Alternatives considered

**Rely on schema parsing to clone nested metadata.** The shared JSON schema intentionally validates through a predicate, so nested objects retain their caller identity. Explicit serialization fixes the persisted JSON meaning before asynchronous work.

**Check cancellation only in the producer loop body.** Obtaining the first value can already start I/O or wait indefinitely. Admission precedes that first request.

**Re-read file bodies for a metadata edit.** Existing verified metadata already contains content references. Reusing the canonical page writers avoids another tree codec and permits bounded metadata-only composition.

## Consequences

Writers can leave unreferenced immutable objects after cancellation but never return a completed root for that cancelled invocation. The persisted stream format is unchanged and requires no state migration. The caller closes reference readers and supplies retained bodies for later reads or transport. Current cloud Workspace head, archive and mount integration remains separate required work.

Real held-write tests reproduce original-signal replacement and nested metadata mutation for both writer modes. Pre-cancelled cases assert that neither producer starts. Reference composition changes entry names and modes without body I/O, and the normal complete reader verifies the resulting file bytes. See the [postmortem](../../../postmortem/0119-portable-writer-retained-mutable-inputs.md).
