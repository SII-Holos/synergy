# Decision Record: Drain shared export before source surrender

Status: implemented

## Problem

[PM0156](../../../postmortem/0156-surrendered-sync-source-disconnected-return-target.md) demonstrates that a retained old-driver transcript queue can close the original Runtime's bridge after a successful outbound handoff, blocking a later return to that member.

## Decision

The exporter resolves its original Core lineage together with the canonical native epoch before remote synchronization. Draining, frozen and surrendered sources dispatch no new projection work. The organization portability owner waits outside transactions for accepted exporter callbacks to settle before final source freezing. This transient drainage remains in the existing exporter and portable owner, and retains queue data for a verified future epoch.

## Alternatives considered

**Authorize the old driver at the service.** Surrender is permanent for that epoch; historical Core metadata cannot restore execution or projection authority.

**Only filter periodic flushes.** An accepted request can still be in flight when source ownership changes. Final freezing also drains those callbacks.

**Delete the transcript queue after surrender.** This would destroy retained history and recovery information without establishing physical or remote completion.

## Consequences

The original member remains connected and can receive the same Session through a valid newer epoch. Service authorization is unchanged. Real epoch and held-request tests verify no post-surrender dispatch and drainage before completion; the two-Runtime return test exercises the resulting bridge lifetime.
