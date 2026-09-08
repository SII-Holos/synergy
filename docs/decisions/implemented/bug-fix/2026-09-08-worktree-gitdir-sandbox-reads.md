# Decision Record: Worktree gitdir sandbox reads and macOS sh selector metadata

Status: implemented

## Problem

Sandboxed `autonomous` worktree sessions could not run any git command. Three independent macOS deny-default gaps compounded into one visible failure: `fatal: not a git repository: …/.git/worktrees/<name>` plus an `Error opening /private/var/select/sh` notice on every command.

1. A git worktree stores its object database in the original checkout's `.git` directory and points there through its per-worktree gitdir file. `ScopeRoots.trustRoots` correctly excludes the original checkout from a worktree session's trust boundary, so the pointed-to gitdir never entered the sandbox readable roots — deny-default rejected the read and git reported "not a git repository" even though the worktree metadata was intact.
2. On this macOS release `/bin/sh` is a universal-binary selector that opens `/var/select/sh` to pick its bash variant. The compiled profile's readable roots covered `/bin`, `/usr/bin`, and the developer toolchains but not `/var/select`, so every wrapped command logged the denied selector open.
3. Git validates a worktree gitdir by stat-ing every path component between the filesystem root and the gitdir (`/Users`, `/Users/<name>`, …). Deny-default profiles had no metadata allowance on those ancestor components, so git failed with `Invalid path '/Users'` once the gitdir itself became readable.

## Decision

- `MACOS_DEVELOPER_READ_ROOTS` includes `/var/select` and `/private/var/select` so the `/bin/sh` selector resolves inside deny-default profiles. These roots stay macOS-only (`macosPlatformReadRoots`); the Linux bwrap root list is unchanged.
- `EnforcementGate.create` seeds `<originalCheckout>/.git` into `approvedReadPaths` when `workspaceType === "worktree"` and the directory exists. The seed is sandbox-only: it never enters trusted roots, capability classification, or writable roots, so reads of the original checkout outside `.git` remain external and writes stay denied. All three gate creation sites already pass `originalCheckout`, so the fix is one location.
- `MacOSPolicy.compileProfile` emits one parameterized `(allow file-read-metadata …)` rule covering the canonicalized path components of every readable root. Metadata permission grants stat only — never directory listing or data reads — so sibling-deny user-data isolation is unchanged.

## Alternatives considered

**Trust the original checkout in worktree sessions.** Would re-open the documented boundary: writes, working-tree reads, and hook/code execution in the original checkout would all classify as inside-workspace. The scoped `.git`-only seed keeps the write boundary external.

**Mount or symlink the gitdir inside the worktree.** Worktree creation and repair is runtime-managed and git owns the per-worktree gitdir file; a shadow copy would drift from the real object store and break concurrent commits from other checkouts.

**Broaden `defaultRuntimeReadRoots` instead of macOS-only roots.** `/var/select` does not exist on Linux, and `defaultRuntimeReadRoots` feeds both platforms; keeping the selector paths behind `macosPlatformReadRoots` avoids dead roots and keeps the non-darwin root list stable.

**Grant `file-read*` on path components instead of metadata-only.** A full read allow on `/Users` components would let any sandboxed process list the home directory, defeating the sibling-deny user-data isolation the profiles exist to provide.

## Consequences

Git read commands (`status`, `log`, `diff`, `branch`) work inside sandboxed worktree sessions, verified end to end through `SandboxBackend.executeAsync` with the production profile compilation. The `/bin/sh` selector noise disappears from every wrapped command. Writes into the original checkout — including its `.git/config` and `.git/hooks` protection semantics — remain external under autonomous. The metadata rule slightly widens what sandboxed processes can stat (path existence and shape for readable-root components), which git requires and which reveals no file contents. Documented in the architecture `execution-boundaries.md` worktree and sandbox sections.
