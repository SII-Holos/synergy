# Decision Record: Worktree gitdir enumerated sandbox read grants

Status: implemented

## Problem

Sandboxed `autonomous` worktree sessions cannot run any git command: every `git status`, `git log`, `git branch`, or `git diff` fails with `fatal: not a git repository: <checkout>/.git/worktrees/<name>`. The failure is not metadata corruption — the per-worktree gitdir is intact — but the macOS deny-default sandbox profile: a linked worktree resolves its object store through the original checkout's `.git` directory, the trust boundary keeps the original checkout external, so git's read of the pointed-to gitdir is rejected and git reports the store as missing. #1358 fixed the two macOS gaps that share this regression (the `/bin/sh` selector and ancestor `file-read-metadata`) but deliberately excluded the worktree gitdir grant, leaving the regression open with the boundary question deferred.

An earlier proposal seeded the whole `<checkout>/.git` directory as a sandbox read root. The review of that proposal identified the concrete costs: the shared `.git` directory carries executable configuration (hooks, `core.fsmonitor`, credential helpers) that a read grant makes executable in-sandbox, the common directory is shared with the main checkout and sibling worktrees so any write-capable grant would span checkouts, and a read-only grant leaves git half-working (reads OK, writes fail) which is harder to diagnose than a clean failure.

## Decision

`worktreeSandboxReadGrants()` in `packages/harness/src/sandbox/policy.ts` derives an enumerated read grant set for a linked worktree instead of a directory grant: the per-worktree gitdir plus the common store's `objects`, `refs`, `packed-refs`, and `config` (validated by experiment as the minimal set git read commands need — git refuses to start without config, and excluding `info` changes nothing). The derivation is fail-closed: the worktree `.git` pointer file must resolve under `<checkout>/.git/worktrees/`, and the gitdir's `commondir` must resolve exactly to `<checkout>/.git`; any mismatch — forged pointers, escaped commondir, or a non-linked directory typed as a worktree — yields an empty grant set.

`EnforcementGate.create` seeds those grants into `approvedReadPaths` only when `workspaceType === "worktree"`, keeping them out of trusted roots, capability classification, and writable roots. Verified through the production deny-default compiler and real `sandbox-exec` runs: `rev-parse`/`status`/`log`/`branch`/`diff` succeed, `git commit` fails cleanly at the `index.lock` write (read-only semantics hold), and hooks, reflogs, `FETCH_HEAD`, and the original working tree remain denied. Config readability is required and carries the same risk as the already-granted `~/.gitconfig` (no credential material beyond embedded-URL remotes, which the working environment does not use); hook execution remains structurally impossible because hooks are not in the grant set.

## Alternatives considered

**Seed the whole `<checkout>/.git` directory** (the earlier proposal). One root, no enumeration, but grants sandboxed processes read (and via `(allow process-exec)` + read, execution) of hooks and executable configuration, exposes reflogs and `FETCH_HEAD`, and makes the read/write boundary of the shared store ambiguous. Rejected for the same reasons #1358's review rejected it.

**Keep the boundary and leave git broken in sandboxed worktree sessions** (the #1358 deferral). Preserves boundary purity but leaves a documented, fully reproducible functional regression in the product's primary unattended mode, and git is a core workflow — read commands are among the most frequent operations in any session. Rejected: the enumerated grant preserves the boundary's protections (no hooks, no working tree, no writes) while restoring the function.

**Symlink or shadow-mount the gitdir inside the workspace.** Would require intercepting worktree creation and would drift from the real object store; git owns the pointer file and the common-directory layout. Rejected.

**Grant `file-read-metadata` instead of data reads.** Insufficient — git needs object contents, packed-refs, and config to answer any query. Rejected as not restoring the function.

## Consequences

Git read commands work in sandboxed worktree sessions on both sandbox backends (the grant set is backend-neutral: readable roots are forwarded by the macOS deny-default profile and the Linux helper alike). The original checkout's working tree, hooks, reflogs, and `FETCH_HEAD` remain unreadable; the common store stays write-external, so `git commit` inside the sandbox fails at `index.lock` with a clear error rather than mutating shared state; the tool-layer `.git` sensitive-path classification is unchanged, so `cat .git` in bash still requires the ordinary external-read flow. The grants are enumerated, validated, and derived per-session at gate creation, so a forged pointer yields no grant and the surface does not grow with repository size. Documentation in `docs/architecture/execution-boundaries.md` records the grant set and its validation invariants.
