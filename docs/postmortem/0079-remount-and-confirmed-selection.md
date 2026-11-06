# Legacy remounts and confirmed selections blocked directory use

## Executive summary

Unchanged local directories could remain unavailable after a mount device number changed. A successful rebind could then leave the composer using the previous generation. Exact-only migration tests and dialog tests that clicked a second selection action missed the complete recovery journey.

## Summary

Project-folder updates failed identity validation. Rebinding returned success, but the next new-session request returned a stale-selection conflict. Canonical history remained present; these failures concerned directory admission and the selected generation.

## Timeline

A real-data snapshot reproduced legacy identities with matching paths, inodes and birth times but different device numbers. Existing released migration receipts prevented a revised historical migration from running. Rendered tests reproduced the extra selection step, and a central-runner experiment exposed a costly empty-input proof before the bounded catalog migration.

## Root cause

The persistent-volume migration intentionally required an exact legacy identity match, leaving remounted records outside its conversion rule. A dialog rebind changed its local record without applying the returned generation to its target. An implicit main-directory selection could also retain an older project-directory snapshot. First-send failure actions captured that stale selection, and the generic binding-conflict error did not offer directory recovery.

The runner's empty-input proof enumerated storage roots before executing a new catalog migration. On substantial historical storage this dominated the actual directory conversion. Testing only the migration callback did not measure this wrapper cost.

## Guardrails

- [Catalog upgrade tests](../../packages/harness/test/workspace/remount-migration.test.ts) cover bounded reads, central-runner root enumeration, identity mismatches, retries and metadata preservation.
- [Native identity tests](../../packages/local-runtime/test/workspace/identity.test.ts) retain released ledgers and verify catalog and attached-receipt upgrades through startup and restart.
- [Chooser tests](../../apps/web/test/components/dialog/workspace-dialog.dom.test.ts) verify applying confirmation once and preserving unrelated selections.
- [Main-directory interaction tests](../../apps/web/test/components/session/work-context.dom.test.ts) verify a current generation with a retained draft.
- [Production acceptance](../../apps/web/test/fixtures/workbench/verify-project-directory-recovery.ts) exercises replacement, stale selections, recovery, retained drafts and successful manual sends through the real server.

## Lessons

Legacy identity evidence needs an explicit compatibility policy and a new migration receipt, not an edit to a completed upgrade. Recovery completes when the intended task can use the confirmed selection. Measure central startup separately from the migration body; the [decision](../decisions/implemented/bug-fix/2026-10-18-remounted-directory-recovery.md) defines the accepted compatibility and selection behavior.
