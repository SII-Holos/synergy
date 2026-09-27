# Decision Record: Restore saved Workspace content without transferring authority

Status: implemented

## Problem

Object-backed files must move between storage profiles and remain recoverable when a live execution view is lost. Reusing the saved head as the current view would conceal unsaved changes and could clear unresolved ownership.

## Decision

Export a revision-pinned saved manifest and verified chunks in a streaming, versioned archive. Import validates paths, chunk sizes, chunk and whole-file digests, manifest identity and the completion record before atomically publishing a new Workspace. The destination profile is chosen explicitly; archives contain neither deployment settings nor live authority.

Saved-copy recovery uses the same verified transfer and records source provenance. It leaves the original Workspace and unknown execution untouched. CLI and generated HTTP operations provide import and export; Web and Desktop provide saved-copy recovery alongside Workspace selection.

## Alternatives considered

An automatic fallback to the old head would present stale files as current. Copying catalog records would retain foreign credentials, mounts and claims. A single buffered archive would require memory proportional to the complete file set.

## Consequences

Transfer uses bounded manifest and chunk records with backpressure. Interrupted or corrupt imports can leave unreferenced immutable blobs but no usable partial Workspace. Behavioral tests cover binary files, incomplete and corrupt archives, stale revisions, existing export destinations, authenticated SDK transfer, lost-view retention and recovery through the shared UI.
