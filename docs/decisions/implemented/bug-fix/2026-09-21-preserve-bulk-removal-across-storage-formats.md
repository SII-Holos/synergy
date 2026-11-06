# Decision Record: Preserve bulk removal across storage formats

Status: implemented

## Problem

Segment import retires stale file checkpoints through `removeMany`. The bulk remover bound hexadecimal key strings even when format 3 stored binary keys, silently preserving the records. In format 2 it removed bodies but retained the emptied traversal nodes.

## Decision

Bulk removal uses the namespace key encoding, retains revision tombstones, and removes dangling nodes in the same transaction. The existing admission check covers every requested owner before mutation; SQL updates remain bounded to 128 keys. Node cleanup preserves ancestors needed by live siblings.

## Alternatives considered

**Fix only the key binding.** This restores deletion in format 3 but leaves the bulk path outside the structural reclamation contract already enforced by single and subtree removal.

**Delete record rows physically.** This would discard revision fences and allow a delayed compare-and-write to recreate deleted data.

## Consequences

Cleanup adds work proportional to the removed keys and their ancestor chains, while preserving bounded statements and transaction rollback. Real format 2 and format 3 fixtures cover deletion across a batch boundary, rollback, live siblings, stale revisions, retained tombstones and reclaimed nodes. The existing namespace format and public API remain unchanged.
