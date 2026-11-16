# Decision Record: Own VCS observation outside startup tasks

Status: implemented

## Problem

Workspace branch observation resolved mounted files without their required native origin and converted the resulting failure into an absent branch. Its bound callback also retained the first caller's resource frame and Workspace access task after that task closed. The branch cache could return a result to an existing resource caller without checking whether its original authority remained valid.

## Decision

Workbench composition registers the VCS Host before the Runtime opens. A Workspace generation captures its Scope, Workspace identity and storage owner. Every watcher refresh leaves ambient domain contexts, restores those owners, resolves only the selected Workspace's file requirements with a fresh VCS Host invocation, and performs its metadata query in an independent Workspace access task.

Native directories retain native process and claim ownership without selecting an Environment. Dormant object Workspaces return an absent branch without allocating compute. Active mounted Workspaces execute through the selected Environment and record the VCS Host origin. The existing HEAD-only refresh, trailing refresh, branch-change event and disposal behavior remain with the same watcher.

Public initialization and cached reads validate an existing frame's original native origin before and after asynchronous work. A missing origin or foreign Runtime or storage handle fails instead of acquiring Host authority. The cache separately validates its captured owner for callers with no resource frame. A caller whose Task pauses during shared watcher preparation cannot receive that result; the independently owned watcher remains usable by authorized callers.

## Alternatives considered

**Forward the first caller's origin into every refresh.** Shared Workspace observation would retain the first Task's lifetime and stop working when it closed or paused.

**Use the VCS Host for every caller.** This would replace existing resource provenance and allow cached reads or preparation to outlive their caller's admission.

**Select execution for dormant metadata.** A branch panel would allocate compute only to inspect a repository that has no active execution view.

## Consequences

Fixtures select Workbench composition before using its VCS service. Long-lived callbacks retain only their Workspace and storage owners; they do not retain an access task or resource frame. Every public call with a frame incurs two native admission checks. Failed Git queries still represent an unavailable branch, while invalid caller provenance remains an explicit error.

The real native and object-Workspace tests cover closed startup tasks, canonical Session pause during preparation, missing origins, foreign namespaces, identity snapshots, qualified events, zero dormant allocation calls, and native metadata without an Environment. The [postmortem](../../../postmortem/0129-vcs-observation-retained-startup-authority.md) records the failures reproduced before the fix.
