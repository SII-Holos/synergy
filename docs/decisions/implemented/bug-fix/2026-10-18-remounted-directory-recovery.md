# Decision Record: Remounted directory recovery

Status: implemented

## Problem

A legacy directory binding can retain a mount device number that changes while its canonical path, inode and birth time remain the same. Exact-only identity conversion leaves these installed records unusable. Confirming a rebind can also leave a draft pinned to the previous generation, so the next send fails despite successful recovery.

## Decision

A versioned Workspace startup migration permits legacy mount-number changes only for active bound records belonging to the local host namespace, with an unchanged canonical path, positive matching inode and birth time, and a currently available persistent volume identity. It upgrades catalog identity and location indexes without advancing the binding generation. A dependent Local Runtime migration applies the same comparison to its attached native mount receipts. Both retain the released exact-only migrations and their completion ledgers. This supersedes only the mismatched-legacy recovery policy in [persistent volume identity](2026-10-03-persistent-volume-directory-identity.md).

The compatibility comparison is limited to these migrations. Current volume-qualified bindings, unknown identities, missing paths, replaced objects and foreign or unbound history are not adopted. Unknown record fields survive; inspection and storage failures remain retryable migration failures. The catch-up migration runs its own catalog emptiness check rather than the runner's global empty-input proof, which can walk unrelated historical branches. Catalog reads use batches of at most 128 and do not scan Session or message history. Completed startup receipts prevent repeat scans on ordinary restart.

A directory confirmation in a draft or Session chooser applies the returned binding generation to that target and completes selection. Failed first-send recovery restores the captured draft with that selection and clears the obsolete retry action without sending automatically. An implicit project-main choice follows catalog generations newer than its project snapshot; an explicit draft remains pinned across background updates. Stale-selection errors offer current-directory selection instead of requiring another rebind.

## Alternatives considered

**Require confirmation for every legacy device mismatch.** This preserves certainty the old record cannot provide, but imposes recurring recovery on unchanged local directories and breaks ordinary upgrades.

**Accept any directory at the same path.** This would authorize a different object after replacement or import. Matching local namespace, canonical path, inode and known birth time narrows compatibility to remount evidence.

**Refresh every selected generation on catalog events.** A background rebind could silently redirect a user's explicit draft. Confirmation updates its own target; unrelated selections retain generation checks.

## Consequences

Legacy records do not contain their original volume UUID. The migration intentionally accepts the residual possibility of another volume presenting the same path, inode and birth time; this is a compatibility policy rather than proof of original-volume identity. Once upgraded, stable-volume comparison applies normally. File mutation, restore, retirement and active-resource exclusion retain their existing checks.

Tests cover completed released ledgers, fresh startup and restart, native mount receipts, replacement, missing and foreign directories, aliases, unknown metadata, repeated upgrades, inspection errors and bounded catalog work. Rendered chooser tests cover one-confirmation application, failed/cancelled recovery and background generation changes. Full-product acceptance verifies retained drafts and successful sends after recovery.
