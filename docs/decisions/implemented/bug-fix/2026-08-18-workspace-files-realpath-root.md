# Decision Record: Resolve the workspace root before realpath containment checks

Status: implemented

## Problem

`WorkspaceFileService.assertRealpathInside()` rejected any path whose `fs.realpath()` result was not lexically contained in the workspace root. The workspace root itself was taken from `path.resolve(ScopeContext.current.directory)` without ever resolving symlinks. Whenever the scope directory (or a path component above it) is a symlink — for example a project opened through `~/workspace` when `~/workspace` itself is a link — every file's real path fell outside the lexical root and the workspace Files panel returned 500 errors (`Access denied: real path escapes workspace`) for `children`, `read`, and `stat`. Opening a freshly created markdown file under `docs/` surfaced this immediately.

## Decision

`assertRealpathInside()` now resolves both sides of the containment check: the target path and the workspace root are both passed through `fs.realpath()` before `isPathContained()` compares them. If the root cannot be resolved, the lexical root is used as a fallback so the check never silently widens access. A symlink inside the workspace whose target escapes the resolved root is still rejected, so the security property is unchanged.

In addition, the `children`, `read`, and `stat` routes now catch `AccessDeniedError` and respond with a structured 403 (same shape as the existing `write` route) instead of leaking the error to the generic 500 handler.

## Alternatives considered

- **Resolve the root once at scope creation and store the canonical path** — rejected: the root is already resolved on every call through `ScopeContext.current.directory`, and a stored value would go stale if the symlink target changes or the directory is re-bound to a worktree. Resolving per check is a single `realpath` call and keeps the check self-contained.
- **Compare with a canonicalized prefix instead of realpath** — rejected: prefix string comparison is exactly what caused the false positive; realpath is the only correct physical-path comparison on POSIX.

## Consequences

Workspaces reached through symlinked directories now browse and read normally, and genuine symlink escapes still return 403 with a structured error body instead of a 500. The per-request cost is one extra `realpath` syscall for the root, which is negligible relative to the directory listing and stat work these routes already perform. The `write` route's structured-error contract now applies uniformly across all workspace-file routes.
