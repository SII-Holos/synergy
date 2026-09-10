# Decision Record: Worktree gitdir enumerated sandbox read grants

Status: implemented

## Problem

Sandboxed `autonomous` worktree sessions cannot run any git command: every `git status`, `git log`, `git branch`, or `git diff` fails with `fatal: not a git repository: <checkout>/.git/worktrees/<name>`. The failure is not metadata corruption — the per-worktree gitdir is intact — but the macOS deny-default sandbox profile: a linked worktree resolves its object store through the original checkout's `.git` directory, the trust boundary keeps the original checkout external, so git's read of the pointed-to gitdir is rejected and git reports the store as missing. #1358 fixed the two macOS gaps that share this regression (the `/bin/sh` selector and ancestor `file-read-metadata`) but deliberately excluded the worktree gitdir grant, leaving the regression open with the boundary question deferred.

Three coarser grant shapes were evaluated and rejected on the way to the shipped design. Seeding the whole `<checkout>/.git` directory exposes executable configuration (hooks, `core.fsmonitor`, credential helpers) that a read grant makes executable in-sandbox, spans the main checkout and every sibling worktree, and leaves the shared store's write boundary ambiguous. Granting the per-worktree gitdir as a directory is narrower but still too broad: `git worktree add` creates `logs/HEAD` inside it and `git fetch` resolves `FETCH_HEAD` into it, so a directory grant reads that worktree's reflogs and fetch metadata — and granting optional files unconditionally breaks bind-based backends, since the Linux helper binds every readable root and young repositories have no `packed-refs`, which fails every command at bind time. Finally, a workspace `.git` pointer aimed at a sibling worktree's metadata entry passes commondir-only validation and would inherit the sibling's branch and index.

## Decision

`worktreeSandboxReadGrants()` in `packages/harness/src/sandbox/policy.ts` returns an enumerated, per-file read grant set. Per-worktree files: `HEAD`, `commondir`, and the `gitdir` backlink are required — experiment shows git refuses to recognize a linked worktree without reading all three — and `index`, `ORIG_HEAD`, and `config.worktree` join the set only when present. Common store: `objects` and `refs` directories plus `config`, `packed-refs`, `info/exclude`, and `info/attributes`, the latter four existence-filtered so bind-based backends never receive a missing source. `info/exclude` and `info/attributes` keep repository-local ignore rules authoritative so `git status` does not report locally ignored files as untracked; `config` is required — git refuses to start without reading it — and carries the same risk as the already-granted `~/.gitconfig`.

The derivation is fail-closed: the workspace `.git` pointer file must resolve under `<checkout>/.git/worktrees/`, the gitdir's `commondir` must resolve exactly to `<checkout>/.git`, and the metadata entry's `gitdir` backlink must resolve exactly to this workspace's pointer, so a pointer aimed at a sibling worktree's metadata entry yields an empty set. Any mismatch — forged pointers, escaped commondirs, directory-style `.git` — returns no grants.

`EnforcementGate.create` seeds those grants into `approvedReadPaths` only when `workspaceType === "worktree"`, keeping them out of trusted roots, capability classification, and writable roots. Verified through the production deny-default compiler and real `sandbox-exec` runs against a fresh repository: `rev-parse`/`status`/`log`/`branch`/`diff` succeed with `info/exclude` honored (`git check-ignore -v` resolves to it), `git commit` fails cleanly at the `index.lock` write, and hooks, the per-worktree reflog, `FETCH_HEAD`, metadata directory listings, and the original working tree remain denied.

## Alternatives considered

**Seed the whole `<checkout>/.git` directory** (the earlier proposal, rejected in #1358 review). One root, no enumeration, but grants sandboxed processes read (and via `(allow process-exec)` + read, execution) of hooks and executable configuration and makes the read/write boundary of the shared store ambiguous.

**Grant the per-worktree gitdir as a single directory** (the first shipped version of this fix, corrected after review). Simpler set math, but a directory grant covers `logs/HEAD` and `FETCH_HEAD`, reads that worktree's reflogs and fetch metadata, and cannot existence-filter per file for bind-based backends. Replaced by per-file enumeration.

**Keep the boundary and leave git broken** (the #1358 deferral). Preserves boundary purity but leaves a fully reproducible functional regression in the product's primary unattended mode. The enumerated grant preserves the boundary's protections while restoring the function.

**Symlink or shadow-mount the gitdir inside the workspace.** Would drift from the real object store; git owns the pointer file and the common-directory layout. Rejected.

**Grant `file-read-metadata` instead of data reads.** Insufficient — git needs object contents, packed-refs, and config to answer any query. Rejected.

## Consequences

Git read commands work in sandboxed worktree sessions on both sandbox backends; the grant set is backend-neutral and safe for the Linux helper because every optional file is existence-filtered. The original checkout's working tree, hooks, both reflogs, and `FETCH_HEAD` remain unreadable; the common store stays write-external, so `git commit` inside the sandbox fails at `index.lock` with a clear error rather than mutating shared state; the tool-layer `.git` sensitive-path classification is unchanged. Repository-local ignore rules now resolve inside the sandbox, so `git status` output matches unsandboxed runs. The sibling-backlink validation means a workspace pointer forged at another worktree's metadata entry yields no grants and git fails exactly as it does without the feature. Documentation in `docs/architecture/execution-boundaries.md` records the grant set and its validation invariants.
