# Decision Record: Scope sandbox metadata protection to writable roots

Status: implemented

## Problem

The macOS sandbox matched protected metadata names anywhere in an absolute path. An admitted workspace beneath a `.codex` or `.agents` ancestor therefore rejected ordinary writes. A shell could still return success after printing its working directory, hiding the failure from a shallow smoke test.

## Decision

Local Runtime anchors each metadata-name expression to the canonical writable root. It protects matching directory components inside every admitted root, including nested metadata, without treating ancestor components as workspace metadata. The compiler escapes regular-expression characters and serializes the expression as a Seatbelt string, preserving roots containing punctuation, spaces and quotes. Filesystem root grants, credential denies, network policy and control-profile decisions retain their existing owners.

The real-kernel regression in [macos-policy.test.ts](../../../../packages/local-runtime/test/sandbox/macos-policy.test.ts) verifies successful ordinary writes and unchanged protected files across primary and additional writable roots. It also checks sibling refusal and ordinary names containing a metadata-name suffix. The [postmortem](../../../postmortem/0067-isolated-runtime-containment-gaps.md) records the reproduction gaps that exposed this defect.

## Alternatives considered

**Move every development checkout out of metadata-named directories.** This hides a valid workspace configuration and leaves the absolute-path matcher incorrect for users.

**Remove metadata protection or bypass guarded execution.** Both would allow modifications to executable agent configuration and fail to preserve the selected profile.

**Restrict metadata only at the root's immediate children.** That would discard the existing protection for nested metadata directories.

## Consequences

Guarded commands can write ordinary files from admitted nested workspaces. Metadata protection still applies at every depth inside each canonical writable root. The change is confined to the macOS compiler; Linux and Windows policy is unchanged. Native regression checks require macOS and skip elsewhere. No persisted-state upgrade or API change is required.
