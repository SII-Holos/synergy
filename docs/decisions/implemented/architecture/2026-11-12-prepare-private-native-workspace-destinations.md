# Decision Record: Prepare private native Workspace destinations

Status: implemented

## Problem

Receiving complete file pages does not establish a native destination or authorize a Workspace catalog binding. Preparation can finish its filesystem publication before its SQL receipt is observed. Retrying by deleting an occupied directory risks losing unrelated files. Re-sanitizing Git during verification can hide changes to the destination's actual configuration.

## Decision

Local Runtime's `workspace/portable-target` prepares a private destination identified by the handoff, Scope and original Workspace. A canonical pending intent fixes the exact portable root and destination before materialization. An occupied destination without that intent rejects preparation. A retry verifies the original files and advances only that same intent; it cannot replace its immutable source or delete an unknown directory.

The prepared receipt retains the native directory identity, destination host, reserved catalog identity and original file root in the owning private Store. Preparation publishes no Workspace catalog row or execution binding. Cold validation rereads the exact receipt, native directory identity and all file bytes.

`NativeWorkspacePortableTree.verify` measures the actual materialized tree using its disk inventory and bounded page codec, with a local checksum sink. It runs no Git commands, exports no content and applies no Git sanitization to the measured destination. Added or changed metadata therefore cannot disappear from verification. Capture continues to sanitize Git and enforce working-file credential policy independently.

Native publication uses an explicit callback that retains exclusive directory claims through its entire body. Only that open frame can return the prepared location for catalog publication; copied receipts, escaped callbacks, a foreign primary Store or changed artifact configuration do not replace the current writer. The callback qualifies native file ownership, while the Session epoch owner independently authorizes activation. The aggregate target owner composes both.

The public Harness `storage/queue` entry exposes the existing queue scope. Native preparation propagates its original cancellation through metadata and artifact waits. It neither replaces Storage admission nor creates another queue.

## Alternatives considered

**Delete a directory when its completed receipt is absent.** A crash between filesystem publication and SQL receipt leaves original verified data, and an unrelated occupied directory must remain untouched.

**Verify a sanitized Git capture again.** This omits newly added hooks or remotes instead of detecting their presence in the prepared destination.

**Publish a catalog during preparation.** Ordinary navigation and file access must not observe a partially prepared target. Catalog publication belongs to the native epoch activation transaction.

## Consequences

Verification reads the full native tree with bounded memory and temporary disk inventories. Native receipts and paths remain private. These primitives do not implement cloud resource CAS, existing-directory difference acceptance, aggregate Workspace mapping or Session activation by themselves.

## Verification

`test/workspace/portable-target.test.ts` uses real temporary Runtime Homes, the native coordinator and SQLite to exercise private preparation, changed bytes, exact publication frames, cold reopening, foreign artifact settings and receipt-loss roll-forward. Its original-signal cancellation case holds a real artifact checkpoint while preparation's native read queues behind it. `test/workspace/portable-tree-git.test.ts` verifies a restored independent Git tree and rejects a later configuration edit without sanitizing it away.

## Related

- [Independent Git preparation](2026-11-12-materialize-independent-git-workspaces-for-native-transfer.md)
- [Workspace ownership](../../../architecture/workspace-and-files.md)
- [Paused Session transfer](../../../architecture/session-transfer.md)
