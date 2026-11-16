# Portable links retained host-specific permissions

## Executive summary

Native portable trees retained a symbolic link's source permission bits but restoration created the destination platform's default link. Complete verification rejected that legitimate restoration. Portable link metadata must have one cross-platform representation while regular file and directory permissions remain exact.

## Summary

Investigation of an incomplete cross-platform Target preparation exposed a deterministic owning filesystem failure. The same original data prepared successfully between two Darwin Members. A smaller real Darwin roundtrip changed only a contained source link's permission bits and failed with `Portable Workspace changed after materialization`. This established the owner defect independently; it did not establish the unobserved lower error from the original Linux Target.

## Timeline

- The original cross-platform run froze the source, then its Target preparation rejected without cancellation or a completed signed receipt.
- A real same-data Darwin-to-Darwin preparation completed, retaining the cross-platform uncertainty.
- The real `lchmod` roundtrip failed before the fix; a bounded-reference control also retained the wrong mode.
- Both owning paths use canonical portable link mode `0777`; Darwin restoration applies it with `lchmod`.

## Root cause

Capture serialized `lstat.mode` for every kind. Restoration applied modes to files and directories but only created symbolic links. Linux ordinary links have fixed `0777` permissions, while Darwin can retain another mode. Including the unportable source bits in the streamed digest made otherwise exact destination bytes and link targets unequal.

## Guardrails

The owning [decision](../decisions/implemented/architecture/2026-11-12-stream-native-workspace-trees-through-portable-pages.md) defines the new paged format's canonical link mode. Source identity checks still include the original complete stat tuple. Verification still compares the complete tree digest without reading remote objects or ignoring metadata. The Darwin filesystem regression preserves source permissions and the referent, checks the canonical destination, and rejects a later file-mode or link-target change. The Harness control verifies that conversion does not mutate a retained bounded header.

## Lessons

A source permission field needs explicit platform semantics before it becomes signed portable metadata. Successful same-platform preparation cannot prove a complete cross-platform handoff; the original full roundtrip and cleanup remain required.
