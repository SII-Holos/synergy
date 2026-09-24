# Decision Record: Reserve writes before Workspace retirement

Status: implemented

## Problem

Directory retirement and native command writes have different footprints. Two cleanup tasks can exclusively hold disjoint directories, then each request a host-wide command whose footprint overlaps the other directory. Neither task can release its lifecycle claim until its command finishes. A nested file write can also wait on its own exclusive claim when it tries to expand the parent task reservation.

## Decision

`WorkspaceAccess.retire` accepts an explicit `writeRoots` footprint and reserves it before acquiring directory exclusion. Worktree cancellation cleanup, explicit or automatic removal, and missing-directory reconciliation declare host-wide writes because their Git operations can invoke user hooks. The native coordinator admits a retirement descendant only when its footprint is covered by an active ancestor reservation or by the retired roots themselves. An undeclared expansion reports `WorkspaceBusyError` before joining a wait cycle.

File mutations under retirement acquire their operation claim through the existing exclusive owner. They do not replace the parent task reservation. Reservation expansion and Cortex-style ownership handoff are refused while retirement is active. Ordinary metadata operations outside retirement retain their short write intervals.

## Alternatives considered

**Ignore other retirement claims for nested commands.** This would make an unrestricted command able to write another directory during its exclusive removal or rebinding.

**Treat every Git operation as metadata-only.** Git hooks, filters and helpers can write outside repository metadata. Narrowing the declared footprint without constraining the command would discard the existing native safety guarantee.

**Increase cancellation deadlines or retry the full test shard.** A circular wait cannot complete until an owner is terminated; more time and passing reruns do not remove that dependency.

**Serialize all directory retirement host-wide.** Pure file retirement needs only its declared roots. Broader reservation is explicit so unrelated bounded work retains concurrency.

## Consequences

Independent cleanup commands serialize only when their actual conservative write footprints overlap. Their directory claims continue to exclude unrelated users and native processes. Callers must declare broader writes before entering retirement; accidental later expansion becomes a visible failure rather than a hidden deadlock. Coordinator and real temporary-filesystem tests cover rejection, nested writes, unchanged foreign ownership and cleanup. The [incident record](../../../postmortem/0031-concurrent-worktree-retirement-deadlock.md) describes the reproduction and diagnostic evidence.
