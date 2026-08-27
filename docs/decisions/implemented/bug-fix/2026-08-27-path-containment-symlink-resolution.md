# Decision Record: Resolve symlinks component-wise in path containment

Status: implemented

## Problem

`isPathContained` backed the workspace read/write boundary and 20+ callers via `Scope.contains` / `Filesystem.contains`, but its check was purely lexical (`path.resolve` + `path.relative`). A symlink created inside the workspace and pointing outside (e.g. at `/etc` or another project) was treated as contained, so any gated filesystem access could follow the link out. A first fix attempt canonicalized both sides with whole-path `realpathSync.native`, falling back to the lexical form whenever realpath failed. That closed the existing-link/existing-file case but left two escapes and one regression, all rooted in the same fact: realpath fails with ENOENT whenever _any_ component is missing — most commonly the final one, a file about to be written:

- **Write-through escape**: for `workspace/escape-link/new-file` the child fell back to its lexical form while existing links stayed resolvable; the check passed and the write landed outside the workspace. `WorkspaceFileService.assertRealpathInside` was equally blind (its `realpathIfExists` returns `undefined` for missing paths and skips the check), so no deeper layer caught it.
- **Dangling-link escape**: a link whose target did not exist yet also ENOENTed, fell back lexically, and passed; writing through it would _create_ the target outside the workspace.
- **Symlinked-prefix regression**: when the workspace path string itself crossed a symlink (macOS `/tmp` → `/private/tmp`), the parent canonicalized while a not-yet-created child stayed lexical; the cross-coordinate-system comparison falsely reported an escape and rejected every new file.

## Decision

`canonicalize()` inside `path-contain.ts` now resolves symlinks **component by component** rather than whole-path-or-lexical. This complements [the workspace realpath-root fix](2026-08-18-workspace-files-realpath-root.md), which already resolved both sides of the `assertRealpathInside` comparison but remained blind to missing paths:

- Wherever a prefix exists, `realpathSync.native` resolves it, so links are followed at any depth.
- When a component is a link whose realpath fails because its target is missing, `readlinkSync` resolves the redirect anyway — a write through a dangling link is still detected as leaving the boundary.
- Genuinely missing components (which have no link to follow) stay lexical, preserving file creation inside the workspace.
- Windows device-prefixed forms returned by `realpathSync.native` (`\\?\C:\...`, `\\?\UNC\...`) are stripped so every returned form lives in one coordinate system.
- Chained links are capped at the kernel's SYMLOOP_MAX (40); beyond that the remainder stays lexical, matching what the OS itself refuses to resolve.
- Components that cannot be resolved at all (EACCES, ELOOP past the cap) keep their lexical form, which is never wider than the pre-fix behavior.

`isPathContained` remains the single containment primitive; no caller changed. The stale "pure string analysis — no filesystem I/O" contract on `PathClassifier.classifyPath` was corrected — containment may now touch the filesystem. Tests cover the existing-link escape, the write-through escape, the dangling link, internal links with missing tails, the symlinked-prefix workspace, and the create-inside-workspace positive path.

## Alternatives considered

- **Whole-path realpath with lexical ENOENT fallback** (the first attempt) — rejected by runtime evidence: it re-opened both escapes precisely on the write path it existed to protect and falsely rejected creation in symlinked-prefix workspaces. A non-existent final component is the normal case for writes, so "realpath failed" does not mean "no link to follow".
- **Fail closed (reject when realpath fails)** — rejected: every legitimate create-inside-workspace operation would be denied, since the file about to be written does not exist yet.
- **Resolve only the deepest existing ancestor, then re-append the missing tail** — rejected after prototyping: it closes the write-through case but cannot see a dangling link at an intermediate component, leaving the dangling-link escape open. Component-wise resolution covers both at similar cost.
- **openat/O_NOFOLLOW or post-write realpath verification at each call site** — deferred: a true TOCTOU-proof boundary needs descriptor-relative operations, which a shared string-comparison utility cannot provide. `isPathContained` shrinks the window from permanent to racy; descriptor-level enforcement belongs to the file-access layer, not the containment predicate.

## Consequences

All symlink escape variants — existing link, write-through, and dangling link — are rejected, and workspaces reached through symlinked prefixes no longer reject new files. The check is no longer free of filesystem I/O: it issues stat/realpath syscalls per comparison, measurable on hot paths that classify many paths (enforcement classification, watchers), and callers that documented it as pure string analysis must not rely on that anymore. Containment remains a check-then-use predicate, so a symlink planted between check and use can still race; the boundary is materially stronger than lexical comparison but is not a descriptor-level guarantee. Windows junction behavior is exercised in CI through the platform-branched test fixtures, and the `\\\\?\\`-prefix normalization keeps comparisons consistent where `realpathSync.native` returns device paths.
