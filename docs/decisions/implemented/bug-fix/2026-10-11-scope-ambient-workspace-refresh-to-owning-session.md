# Decision Record: Scope ambient workspace refresh to the owning session

Status: implemented

## Problem

A delegated child session's worktree bind ran `ScopeContext.refreshWorkspace()` unconditionally inside the parent's ambient async context. The ambient workspace overlay was overwritten with the child's git worktree, while the parent session's persisted workspace stayed on the main directory. On the parent's next wake, `assertExecutionContext` compared the two, refused to continue outside the session workspace, and froze the session: every `task(..., worktree: { create: true })` dispatch risked wedging its parent.

## Decision

`ScopeContext.refreshWorkspace()` accepts an optional owning `sessionID`. When one is supplied, the refresh is refused only while an ambient workspace task exists and belongs to a different session; callers with no ambient task (archive, janitor and other management paths) and the owning session itself keep the legacy refresh semantics. `WorkspaceAccess` exposes `ambientSessionID()` so the guard can distinguish those three states. `Worktree` bind/leave call sites pass the target sessionID. The bridge from scope/context to workspace/access resolves through a lazy `require` at first guard use because scope/context sits on the import path of workspace/access and a static import would close a module cycle.

## Alternatives considered

**Session-partitioned Context stores.** Copying the ambient store whenever an ambient task has a session would isolate every `Context.create` consumer without call-site cooperation, but changes the shared overlay semantics relied on by scope and session transition code and touches every context in the runtime.

**Gate on `WorkspaceAccess.owns()` alone.** The first implementation refused the refresh whenever the ambient task did not own the target session, including when no ambient task existed at all. That broke management flows that legitimately refresh while bare — the archive regression suite failed ("historical caller cannot acquire source checkout authority"), so the guard was narrowed to only foreign ambient tasks.

**Dropping the workspace-mismatch assertion or matching by path containment.** That would treat the symptom at the check site while tool execution keeps running in the wrong directory, weakening the isolation the assertion enforces instead of stopping the pollution.

## Consequences

A child session's worktree bind or leave observed from a foreign ambient task no longer overwrites the parent's ambient workspace; the parent's next wake passes the execution-context assertion and continues normally. Regression coverage ([worktree-context-isolation tests](../../../../packages/local-runtime/test/workspace/worktree-context-isolation.test.ts)) pins both directions: foreign ambient tasks are refused, and the owning session's own worktree_enter still refreshes immediately. Harness workspace suites and the local-runtime worktree suites pass unchanged; management paths without an ambient task retain their previous refresh behavior. Callers of `refreshWorkspace()` without the optional parameter see no behavior change.
