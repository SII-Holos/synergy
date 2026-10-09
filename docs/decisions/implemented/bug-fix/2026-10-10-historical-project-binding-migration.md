# Decision Record: Preserve historical bindings during startup migration

Status: implemented

## Problem

Project-directory and embedded Session Workspace migrations convert retained metadata by registering each directory again. An existing Workspace with a legacy or mismatched physical identity rejects that registration; an unavailable path can fail even before project conversion. Either error prevents startup or historical Session import. The [postmortem](../../../postmortem/0062-project-migration-required-live-directory-identity.md) records why missing-directory and identity-upgrade fixes did not cover this composition.

## Decision

Historical conversion uses `WorkspaceBinding.locateHistory()` to resolve existing host-qualified catalog locations before inspecting the filesystem, then rechecks inside the creation transaction. IDs, bindings, generations and historical Worktree metadata are retained. Unregistered locations use the host location reader; missing, inaccessible, non-directory and looping-symlink paths retain an unverified reference. Canonical aliases contribute one folder. Existing historical Worktrees remain on their recorded host without creating local authority. Unexpected identity-provider errors, malformed records and storage failures still abort conversion without a completion receipt. Existing descriptors use read-only catalog lookups and do not wait for an unrelated writer.

The existing project and Session migrations own the changes because their stored formats are unchanged and failed upgrades have no completion receipt. Completed upgrades do not replay. Default Workspace description uses the same historical conversion. The physical-identity migration retains looping symlinks as unavailable, like missing or inaccessible directories. Project conversion does not depend on that migration having run first. Sharing updates deduplicate Workspace IDs and retain active bound grants on the same host, removing grants to known retired or unavailable bindings. Unknown references still go through catalog validation. Native access independently validates each binding. Explicit registration, adoption and rebinding retain their existing identity checks.

## Alternatives considered

**Run the physical-identity migration first.** Exact legacy matches can upgrade, but a changed mount number deliberately fails that exact-match condition. Reordering cannot make all retained metadata readable and couples unrelated conversion to live directory availability.

**Automatically adopt the current directory identity.** This would give a replacement directory the authority of historical files and invalidate the explicit recovery requirement.

**Skip failed projects or catch the whole migration.** Either approach can lose references or mark partially converted state complete while concealing a storage failure.

## Consequences

Historical directory problems do not prevent server admission. Affected folders remain visibly unavailable until explicit recovery, while project and conversation history remain readable. Schema-derived fixtures from releases 2.0.0, 2.4.4, 3.0.21 and 3.0.22 use frozen release migration ledgers through full Runtime startup, history reads and restart. Focused tests also cover permissions, exact legacy upgrades, changed mount numbers, retirement, foreign Worktrees, partial conversion and retry. Real-data acceptance compares original and repaired sources against credential-free isolated snapshots, preserving the original dataset.
