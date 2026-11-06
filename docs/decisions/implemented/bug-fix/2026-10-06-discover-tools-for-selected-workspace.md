# Decision Record: Discover tools for the selected Workspace

Status: implemented

## Problem

Tool discovery filtered Workspace-dependent tools using only a local directory, while execution also accepted the Session's logical Workspace. Object-backed Sessions could execute file tools yet fail to discover dependent capabilities.

## Decision

Pass the Session Workspace ID into the existing registry availability check. Discovery remains read-only and does not allocate compute. Existing permission and user-tool filters still apply.

## Alternatives considered

Materializing a directory during discovery would couple metadata to compute. Removing Workspace requirements or weakening host companion rules would expose tools without their required resources. Both are unnecessary when the Session already records the selection.

## Consequences

Tests cover selected and absent logical Workspaces, explicit tool disabling and zero Environment allocations. See the [postmortem](../../../postmortem/0055-discovery-omitted-workspace-selection.md).
