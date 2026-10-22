# Decision Record: Recoverable worktree retention

Status: implemented

## Problem

An idle gap between task turns is insufficient evidence that a checkout is disposable. A catalog retirement fence published before native exclusion can outlive a busy cleanup failure and prevent subsequent input or workflow execution. Physical removal also needs durable recovery evidence without changing the Session's selected files.

## Decision

Automatic cleanup protects unarchived canonical references and unfinished execution, including durable Inbox work. Eligibility is checked again in the catalog write transaction; unarchive cannot commit through a deleting fence. The cap is soft and orders eligible work by the latest archive or detach time.

Native exclusion precedes the deleting fence. Local Runtime owns a versioned Git recovery recipe in the canonical Workspace record, alongside a pinned commit. Only clean, fully verifiable checkouts can be released. Catalog state owns release and restore; the existing registry remains an inventory hint rather than a second lifecycle authority. Ordinary input, continuation and workflow execution restore through Session workspace preparation before native execution admission. Explicit worktree entry uses the same restore operation.

A process-owner file lock serializes lifecycle operations across Runtime instances. Native claims still protect active readers and writers. Recovery verifies directory identity, branch, commit and cleanliness, increments binding generation when recreating files, and preserves logical Session identity. Interrupted deletion and restoration reconcile from durable receipts. Missing legacy files, changed branches or occupied paths remain explicit failures rather than selecting another checkout. Historical imports cannot retain local recovery authority. The additive optional receipt requires no rewrite of existing records; retained legacy deleting records use the same verified failure recovery.

## Alternatives considered

**Changing only the sort timestamp.** Better recency ordering does not protect an automatic task between turns or repair a stranded retirement fence.

**Deleting files and rebinding Sessions to the main checkout.** This changes the execution target and cannot restore the original task's files reliably.

**Using ordinary change-history snapshots as a recycle bin.** Snapshot limits and omitted files do not prove a complete backup. Initial release therefore accepts only Git-verifiable clean checkouts and retains uncertain data.

## Consequences

Protected work can exceed the configured cap. Released clean checkouts free working-directory space while keeping a Git commit and small metadata record. The source repository remains necessary for restoration; dirty files and unavailable Git evidence prevent release. Recovery never rewinds a branch that changed after release. Tests cover native contention, both unarchive/fence commit orders, pending work, concurrent restoration, interruption at catalog publication and preserved conversation recency.
