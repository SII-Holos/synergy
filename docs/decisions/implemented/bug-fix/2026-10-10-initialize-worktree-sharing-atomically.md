# Decision Record: Initialize worktree sharing atomically

Status: implemented

## Problem

Creating a worktree from a source with shared directories registered the new Workspace, then changed its sharing through the existing-Workspace mutation path. That path requires exclusive native access. A language server retaining the source directory could therefore block creation of an otherwise independent new worktree and leave its unfinished checkout locked.

## Decision

Workspace registration accepts initial direct sharing references. Catalog registration validates those references with the same rules as later sharing updates and commits them with the new record and indexes in one transaction. Invalid references publish nothing. An existing registration is returned unchanged, even when a repeated request supplies different initial grants.

Binding adoption validates the shared directories' physical identities before entering the catalog transaction. Worktree creation supplies only the selected source's direct grants. Later updates still use `WorkspaceBinding.setSharing()` and retain revision checks, exclusion and event publication. No native claim is cleared or weakened to enable creation.

## Alternatives considered

**Clear retained language-server claims or ignore their uncertainty.** That would discard execution evidence and could allow destructive changes while a native process still owns resources.

**Bypass exclusion for all sharing changes.** Existing Workspaces require protection from concurrent changes to the directories available to their users.

**Publish sharing after registration with a special unguarded setter.** It would expose a partially initialized Workspace and duplicate the sharing mutation path.

## Consequences

New worktrees inherit their direct sharing in their first visible revision, without requesting exclusive access to a source reader. [Catalog tests](../../../../packages/harness/test/workspace/catalog.test.ts) cover concurrent registration, invalid-reference rollback and idempotency. [Worktree tests](../../../../packages/local-runtime/test/workspace/worktree-source.test.ts) hold a real source-directory use during creation and verify that changes to the already registered source remain blocked. The persisted schema and HTTP API are unchanged; existing registrations require no migration or historical scan.
