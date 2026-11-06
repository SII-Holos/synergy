# Mount Number Invalidated Directory Identity

## Executive summary

Starting a Session rejected an existing Workspace because its stored device number differed from the current filesystem metadata while the inode and birth time matched. Tests covered replacement within a mount but not mount-number changes. Durable directory identity must include a persistent volume identifier without weakening replacement detection.

## Summary

History remained readable, but execution failed its directory identity check. The evidence established a changed device number; it did not establish which operating-system event caused the change. Rebinding restored access temporarily but retained the defective identity format.

## Timeline

- Real-data acceptance reproduced a failed Session start.
- Comparing stored and current directory metadata isolated the device-number mismatch.
- Native volume inspection established a stable identifier; behavioral regressions covered safe upgrades and genuine replacement.

## Root cause

The durable catalog and native mount receipt reused a current-mount device identifier. Their independent checks were correct for their stored evidence but the evidence was unsuitable across mounts. Fixing only one owner would leave execution blocked by the other.

## Guardrails added

- [Persistent identity decision](../decisions/implemented/bug-fix/2026-10-03-persistent-volume-directory-identity.md) defines conservative migration and live-claim separation.
- [Native regressions](../../packages/local-runtime/test/workspace/identity.test.ts) exercise catalog and receipt upgrades, unchanged generations and rejected replacement.
- [Identity regressions](../../packages/util/test/filesystem-identity.test.ts) distinguish mount-number changes from volume or object replacement.

- [Project-folder recovery decision](../decisions/implemented/bug-fix/2026-10-04-project-folder-worktree-recovery.md) preserves validation reasons and exposes direct confirmation. The project-folder projection had converted every validation failure to `available: false`, then skipped Git detection; the Composer interpreted that result as non-Git and hid Worktree creation. Regression tests cover visible creation, explicit recovery and retained draft state.
- Obsolete direct-directory mount receipts could also block confirmed rebinding because detachment required the rejected physical identity. Native detachment now validates the immutable mount reference and waits for exclusive ownership before releasing only the watcher and receipt. Materialized mounts still validate physical identity before deleting files; native regressions cover both cases and active users.

## Lessons

An identity format must match the lifetime of the record that stores it. Recovery must preserve negative evidence, and all durable consumers need migration before admission.
