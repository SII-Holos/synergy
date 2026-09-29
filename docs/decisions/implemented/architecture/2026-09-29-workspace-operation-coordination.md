# Decision Record: Separate Workspace use from permission reach

Status: implemented

## Problem

A process permission boundary does not describe a transaction. Translating unrestricted execution into a host-wide writer reservation serialized independent worktrees and left a completed command blocking unrelated tools for the rest of its Session turn. Implicit Git worktree locks also made file observation depend on shared metadata mutation. Permitting concurrent commands requires preserving resource lifetime, save ordering and honest file evidence independently of permission checks.

## Decision

ControlProfile and Sandbox retain permission and containment ownership. Workspace coordination uses nonexclusive resource pins for turns and processes, bounded callback-scoped claims for concrete mutations, and exclusive claims for binding changes and retirement. Raw commands may overlap in the same Workspace; their concurrent writes follow filesystem semantics. Managed file publication keeps byte-version checks, and formatter commands retain their exact file preconditions. Tools no longer acquire implicit Git worktree locks. Explicit user locks and managed creation markers retain their ownership rules.

Execution protocol version 2 carries explicit resource roots and capture references separately from managed mutation roots. Permission reach does not discover additional Workspace captures. Native process trees, streams and durable resource use remain owned until completion and required saving. Old unbounded claims remain intact and recoverable; they continue to block new native admission until released. The bounded retirement ordering from [the retirement decision](../bug-fix/2026-09-23-workspace-retirement-admission-order.md) still applies to declared mutation paths, rather than the possible reach of hooks or helpers.

Checkpoint attempts freeze binding, target, content revision and receipt identity before capture. A stale attempt remains unsaved and cannot replace a newer head. Recovery appends an attempt and captures the current shared view without replaying command effects. Published results survive lost acknowledgements. An owning-domain migration recaptures unfinished legacy receipts without clearing process claims. Overlapping coordinated write intervals and refreshed checkpoints cannot claim exclusive authorship or authorize undo.

The identity and lifecycle portions of [Workspace identity and local bindings](2026-09-23-workspace-identity-and-local-bindings.md) remain in force; this decision supersedes its turn-wide write reservation and host-footprint coupling.

## Alternatives considered

**Release the turn reservation earlier.** This fixes only completed commands; running unrestricted commands would still serialize every worktree.

**Classify tools or shell commands as read-only versus writers.** That duplicates permission policy and cannot reliably describe arbitrary native side effects. Concrete atomic file operations already know their mutation paths without introducing a tool taxonomy.

**Keep one writer for each Workspace.** Independent sessions and native services sharing files still block for whole command lifetimes. Resource pins protect lifecycle without imposing that serialization.

**Discard ownership after process exit or retry the command.** Saving may still be pending, descendants may survive, and command effects may already exist. Durable receipts and distinct save attempts preserve those boundaries.

## Consequences

Independent worktrees and shared Workspaces can run concurrently, including unrestricted commands and language servers. Applications needing transactional arbitrary command writes must supply their own isolation or separate views. Managed mutations remain versioned; conflicting shared snapshots are recoverable and visibly unsaved. File history is deliberately incomplete when exclusive attribution cannot be proved. The client and Execution Host must use matching protocol versions. Regression coverage includes real processes, worktree lifecycle, cancellation, legacy admission, native and transported execution, save conflicts and continued work.
