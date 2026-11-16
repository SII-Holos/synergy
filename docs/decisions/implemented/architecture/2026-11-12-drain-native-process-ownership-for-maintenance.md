# Decision Record: Drain native process ownership for maintenance

Status: implemented

## Problem

A native command can keep writing after its Session lease ends. Its supervisor, descendants, output streams and final Workspace claim release have separate lifetimes. An empty current process presentation registry cannot prove that an earlier native writer stopped, and a failed supervisor start can leave uncertain ownership even when local cleanup completed.

## Decision

Local Workspace and native Environment composition register one `native-processes` maintenance contribution with their actual Workspace coordinators before composition seals. Runtime-owned `OwnedProcess.prepare()` tracks preparation before asynchronous admission and rejects new native dispatch while maintenance holds admission. The lifetime remains tracked through the native completion promise, which includes the supervised tree, drained output, cleanup and original ownership release. Standalone native hosts without an Agent Runtime keep their existing explicit ownership contract; this contribution does not claim their cohort.

Native drainage waits for every tracked preparation and completion without terminating processes, replaying commands or replacing their receipts. Cancellation ends the operator's wait while preserving the native operation. A failed completion or supervisor start without confirmed native cleanup remains a reconciliation requirement; removing a local handle cannot turn it into a successful drain.

After local lifetimes settle, the owner inspects the canonical physical coordinator. Retained non-read claims attributed to the current Home remain blocking, including writers started outside the current resident registry. The coordinator owns native identity and completion checks. The maintenance owner does not replace them with PID snapshots, memory samples, ages or a caller's ready flag. Independent resource cohorts and other Homes retain their own ownership boundaries.

Release validates the original backup lease and grants no execution authority. New native dispatch still passes the canonical maintenance admission gate after confirmed release. No persisted process status or second command receipt is introduced; the resident set only holds actual native preparation/completion lifetimes and uncertain failures.

## Alternatives considered

**Use Session idle or the process presentation registry.** Neither covers every detached native tree, preparation or retained physical claim after a Runtime changes.

**Kill native work while taking a backup.** This changes accepted commands and cannot establish their original output and save receipts. The maintenance owner waits or retains a reconciliation requirement.

**Treat local cleanup after a failed start as complete.** Without the native start acknowledgement there may be no supervisor identity to remove. Cleanup of files and a caller's lease does not provide the missing physical proof.

## Consequences

Long-lived native processes can delay or block maintenance. An uncertain native start or completion remains held for explicit reconciliation, even if another observer believes the process stopped. This is safer than certifying an incomplete backup, but it requires the owning operator's recovery path.

This contribution covers Runtime-owned native process lifetimes and current-Home physical coordinator claims. It does not establish all Workspace mutation drainage, remote Executor or foreign resource ownership, per-Session handoff provenance, hosted restore authority or a complete deployment recovery operator. Those owners must supply their actual proofs separately.

## Verification

`local-runtime/test/process/maintenance.test.ts` runs real supervised subprocesses with controlled stdin. A native tail writes a real file after maintenance begins; drainage waits through its output and claim release, without killing or replaying it. A separate native host outside the current Runtime's resident set leaves a real coordinator claim and blocks maintenance until its original completion. A supervisor starts but its acknowledgement is withheld; local cleanup cannot certify it. Frozen maintenance rejects a new native preparation before its command effect.

## Related

- [Workspace and files](../../../architecture/workspace-and-files.md)
- [Purpose-bound maintenance](2026-11-11-retain-purpose-bound-runtime-maintenance-holds.md)
