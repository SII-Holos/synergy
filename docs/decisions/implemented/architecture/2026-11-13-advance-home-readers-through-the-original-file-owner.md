# Decision Record: Advance Home readers through the original file owner

Status: implemented

## Problem

A domain may need a stricter ordinary reader while retaining the Home's existing format and identity. Pathname replacement after an earlier ownership check can overwrite another directory or marker before a later check discovers the substitution.

## Decision

`HomeOwnershipFile.advanceReader()` accepts an exact complete format-two or format-three marker and a selected target that differs only in its reader. The existing Home file lock serializes cooperating owners. The operation opens the original regular, single-link file without following symlinks, compares the actual descriptor with the inspected path, and retains that descriptor through writing, truncation and synchronization. It verifies the original physical directory and descriptor/path identity around asynchronous effects. Publication never renames a temporary file over the current pathname.

A stale expected marker remains a conflict even if the actual target is already complete. After an unknown acknowledgement, the owner may read and supply that exact current target for an idempotent check. Partial and empty bytes are invalid; a supplied expected object cannot repair them. Legacy and permanently retired formats are outside this operation.

## Alternatives considered

**Check the directory after atomic pathname replacement.** The check can discover a replacement only after another object has already been overwritten.

**Reconstruct interrupted bytes from the requested target.** A serialized request does not establish original native ownership or a complete publication.

## Consequences

The primitive preserves Home metadata and original file identity. It does not create upgrade authority, settle a maintenance hold or authorize execution. Domain central migrations and their original frozen native owners remain responsible for those decisions. The focused lifecycle suite exercises exact-marker advancement, unsupported formats, real directory and marker substitutions, a lost synchronization acknowledgement and incomplete writes.
