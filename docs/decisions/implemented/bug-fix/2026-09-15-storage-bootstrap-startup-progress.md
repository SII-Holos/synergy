# Decision Record: Storage bootstrap participates in managed startup progress

Status: implemented

## Problem

An existing installation can spend longer than the ordinary Desktop health deadline scanning and importing legacy storage before the domain migration runner starts. Successful bootstrap work needs observable progress while HTTP admission is closed.

## Decision

The public startup framing includes aggregate storage stages with increasing step identifiers, item counts and byte counts. Storage bootstrap reports preparation, inventory scanning, backup, inventory publication, owner validation, import, verification, activation and legacy-writer checks. Runtime forwards these events independently of domain migration and execution recovery reporters. The managed server bounds emission frequency while preserving stage transitions.

Built-in CLI commands and version flags dispatch without loading unrelated plugin command metadata. Their startup and offline recovery paths remain callable while storage is importing; root help and plugin dispatch still discover and validate plugin namespaces.

After activation, legacy-writer detection enumerates only namespaces that can hold authoritative records and checks directory entries without statting every artifact. It still rejects recreated records, including Rollout chunk metadata and home-level plugin installation metadata, and propagates errors within authoritative namespaces. Initial backup inventory remains complete and unchanged.

Portable bootstrap archives report both checksum scanning and import work. Database verification and portable import collect bounded progress in memory while the operation runs; a caller-side observer emits it outside retryable transaction callbacks. Counts include work repeated by transaction retries, so a retry cannot silently reset the managed inactivity clock. Completion and activation remain conditional on successful verification and commit.

Desktop renews the existing five-minute inactivity deadline only for advancing storage work or a new step. Storage completion restores the ordinary health deadline. Domain migrations and storage activation can alternate before execution recovery starts; stale storage output cannot reopen completed recovery.

## Alternatives considered

**Increase the ordinary health timeout.** A fixed larger timeout still fails on sufficiently large installations and delays diagnosis when startup actually stalls.

**Report only backup and import counts.** Initial inventory, owner checks and activation can each exceed the ordinary deadline, so reporting only the main copy loop leaves gaps.

**Reuse execution-recovery records.** Execution recovery follows domain migrations; conflating the stages weakens stale-progress rejection and presents misleading status.

## Consequences

The startup schema gains a storage variant, and consumers must understand its ordering. Payloads contain no paths or record contents. Reporting observes work without changing migration checkpoints, backup contents or activation policy. Progress tests cover real legacy fixtures and Desktop deadline transitions.

This change does not reduce the immutable backup, database and journal space budget. A large legacy home can make observable progress and still fail its capacity prerequisite. Restoring availability with a compatible runtime and completing the SQL upgrade are separate operational outcomes; successful progress reporting or a smaller snapshot store must not be presented as proof that the full upgrade completed.
