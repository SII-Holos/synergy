# Decision Record: Authorize logical Workspace file paths

Status: implemented

## Problem

FileView accepts absolute paths under an object Workspace's logical root, but permission classification only received the physical directory. Valid file writes could therefore request external-directory approval before reaching the file host.

## Decision

Pass the selected Workspace's validated logical root from ToolResolver through EnforcementGate and the isolated policy worker. Non-native file classification recognizes exact descendants of that root after rejecting traversal, expansion and control characters. Shell classification and native filesystem authorization retain their existing physical roots. The file host still resolves paths and enforces symlink containment.

## Alternatives considered

Granting external-directory access would widen authority to compensate for a classification error. Rewriting model arguments would hide a supported FileView path form and duplicate its resolution rules. Explicitly carrying the existing namespace keeps classification aligned with the selected resource.

## Consequences

Tests cover relative and absolute logical paths, dormant and mounted classification, isolated policy evaluation, an actual resolved read and write, native isolation, sibling-prefix rejection and traversal rejection. See the [postmortem](../../../postmortem/0050-logical-workspace-path-classification.md).
