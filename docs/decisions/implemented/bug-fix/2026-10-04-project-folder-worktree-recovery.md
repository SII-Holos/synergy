# Decision Record: Project folder and Worktree recovery

Status: implemented

## Problem

Project-folder validation failures became only an availability flag. Git detection then returned false and the Composer hid Worktree creation even for a real repository. Already mismatched legacy directory identities require explicit recovery under the [persistent volume identity decision](2026-10-03-persistent-volume-directory-identity.md), but the ordinary task entry did not explain that distinction.

## Decision

Workbench folder responses retain optional structured `WorkspaceUnavailable` data alongside `available` and `git`. Unexpected validation errors propagate. Missing stable volume evidence is unverified identity, while a different verified identity remains a replacement failure.

The three Composer setup controls retain their accessible names, focus styles and wrapper geometry with inactive Tooltips. The project folder menu always exposes New Worktree. A validated non-Git main disables creation with an explanation. Unavailable main or shared folders open one focused confirmation using registered paths; missing and foreign locations allow an explicit folder choice.

Project controls use the shared floating-surface state tokens. Folder browsing avoids an extra bordered container, and its path-edit action reserves its own space with one inset keyboard focus ring. Long paths retain the current folder without covering that action at narrow widths.

Recovery uses the existing generated `workspace.rebind` API with observed revisions and canonical lifecycle exclusion. It captures connection, Scope, directory configuration and explicit draft selection. Refreshed binding generations and resolved defaults do not count as user selection changes. Sequential recovery preserves successes after a later failure. Uncertain mutation replies read validated folder and catalog state before treating a binding as restored. Project changes cancel remaining requests and cannot update another draft. Retained folder and Worktree projections belong to the current client, connection and Scope. Completion refreshes projections once and selects deferred Worktree intent only when every project folder is available and the main is Git. Actual creation remains owned by task submission.

An obsolete direct-directory mount can release its watcher and receipt under lifecycle exclusion without accessing the unverified directory. Detachment still validates the immutable mount reference and waits for active users. Materialized mounts retain physical validation before deleting their contents. This allows confirmed rebinding while preserving read, write and execution identity guards.

## Alternatives considered

**Ignore device-number mismatches.** A legacy identity does not establish volume continuity. Automatic adoption would accept insufficient evidence and weaken replacement protection.

**Restore only the menu entry.** Native Worktree creation validates the same source binding and would still fail. A visible entry needs an actionable explanation and canonical recovery.

**Add a batch recovery API.** Existing revision-checked rebinding supplies ownership, events and busy-resource protection. Sequential client recovery preserves partial success without adding durable orchestration state.

**Use the generic developer resource dialog.** It exposes custom storage and execution choices beyond ordinary project-folder recovery. The focused dialog confirms existing locations with fewer decisions.

## Consequences

Git eligibility remains distinct from directory availability. Recovery is explicit and can fail while resources are busy; it never forces detachment or rewrites native receipts. Open file tabs retain their opening binding generation and cannot silently redirect pending edits after restoration.

Behavioral coverage extends existing identity, project-folder and Composer suites. Generated-SDK transport tests cover partial failure, uncertain replies and stale revisions; real shared-control DOM tests cover confirmation, cancellation, duplicate clicks, navigation and retained editor state. Existing deferred creation, source ownership and native migration regressions remain in place.
