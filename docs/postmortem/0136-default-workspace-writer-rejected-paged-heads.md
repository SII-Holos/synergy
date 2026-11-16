# Default Workspace writer rejected paged heads

## Executive summary

A valid multi-page saved Workspace could be read and materialized but failed on its first file write or Snapshot restore. The default writer still required a legacy complete manifest, and advancing only that writer would leave native checkpoint save and preservation incompatible. The fix closes the default producer and reverse consumers around the existing indexed graph owners.

## Summary

The public portable format represented real trees across bounded pages. Default mutation reconstructed legacy entries and chunk maps instead of consuming the indexed references. Snapshot restore also requested a complete legacy manifest just to retain selected original file metadata. Native checkpoints and managed imports emitted legacy arrays; Mount save and before-image preservation decoded those arrays directly.

## Timeline

1. A real 513-file paged saved head was published to an isolated object Workspace. Its first write failed with `Paged Workspace content requires its indexed tree owner`.
2. An independent actual Snapshot restore against a paged head failed with the same parser error for both selected files.
3. One canonical writer linked existing indexed chunks and emitted paged roots; native save and baseline preservation reused complete Archive graph validation before checkpoint production changed.
4. A held real root read exposed that Buffer slicing retained caller-owned bytes: the prepared file contained a later byte mutation. Copying input bytes synchronously fixed the snapshot.
5. Actual nested transaction barriers verified cancellation and namespace replacement after the catalog write roll back both the head and its business receipt.
6. Actual native file capture followed by caller selection replacement published an import into another Workspace; synchronous operation input replacement before receipt lookup also retargeted a mutation. Fixing original operation/Workspace snapshots and retaining the source check through the final business commit closed both cases.

## Root cause

Paged support was implemented at readers and transfer consumers without closing the default writer's original full-manifest dependency. Independent producer and consumer assumptions hid a reverse checkpoint path: the next native head does not yet have a catalog saved selection, and both its current and before graphs must be copied under the original receipt. The input snapshot also assumed Uint8Array slice semantics for Buffer subclasses.

## Guardrails

- [x] Machine check: `packages/harness/test/workspace/content-producer.test.ts` mutates a genuine multi-page head and imports another while existing body reads fail, validates legacy relinking, prevents caller input retargeting and checks exact head/receipt rollback after the last write.
- [x] Machine check: `packages/harness/test/workspace/content-paged.test.ts` rejects escaped reference and nested chunk iterators and foreign owners.
- [x] Machine check: `packages/local-runtime/test/workspace-file/restore-paged.test.ts` restores actual selected files from the paged source through Snapshot's original operation.
- [x] Machine check: `packages/local-runtime/test/workspace/mount-paged.test.ts` saves paged native current and before graphs, retains sensitive bytes and survives deletion of original source objects.
- [x] Machine check: `packages/local-runtime/test/workspace-file/managed-transfer.test.ts` changes the caller Workspace after actual native portable capture and verifies publication remains in its original selection.
- [x] Machine check: `packages/presets/test/acceptance/objects.test.ts` retains real publication rollback, acknowledgement recovery and both signed object adapters with default paged heads.

## Lessons

A format becomes the default only when ordinary mutation, reverse save, baseline preservation and real restoration share its canonical owners. Immutable graph validation cannot manufacture a saved selection or replace native publication authority. The [decision](../decisions/implemented/architecture/2026-11-12-write-paged-workspace-heads-through-indexed-chunks.md) keeps legacy input narrow and leaves the larger WorkspaceMove coordinator outside this unit.
