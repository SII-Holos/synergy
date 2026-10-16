# Checkout isolation, recovery and history

## Establish a Safe Checkout

Before editing or staging, run:

```bash
git status --short --branch
git worktree list --porcelain
git remote show origin
git log --oneline -8
```

Classify the current checkout before changing files:

- Direct edits are allowed in the current checkout. Preserve unrelated dirty and untracked files regardless of whether it is the primary checkout or a worktree.
- Continue in a task-owned worktree when it already owns the correct branch, and reuse it for later changes to that branch.
- Treat primary, shared, and otherwise pre-existing checkouts as potentially concurrent. Do not switch branches or rebase them unless the user explicitly requests that operation.
- A user may create or use a topic branch directly in the primary checkout. Use a task-owned worktree when concurrent work needs branch or file isolation, not as a prerequisite for every change.

Branch switches and rebases change repository state observed by every session sharing a checkout. Before an explicitly requested switch or rebase, inspect the branch and dirty state and stop if unrelated concurrent work makes the operation unsafe.

When isolation is useful and no matching worktree exists, create a topic branch and worktree from the verified development base. By default, put task worktrees under the repository checkout's project-local `.synergy/worktrees/` directory with a short filesystem-safe task slug:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
WORKTREE_ROOT="$REPO_ROOT/.synergy/worktrees"
TASK_SLUG=<short-task-slug>

mkdir -p "$WORKTREE_ROOT"
git worktree add -b synergy/<topic> "$WORKTREE_ROOT/$TASK_SLUG" origin/dev
```

This is `<repository>/.synergy/worktrees/<task-slug>`, not the installation or runtime home under `SYNERGY_HOME`. Use a different worktree location only when the user explicitly requests it. If the default path is unavailable, stop and ask rather than silently creating the worktree elsewhere.

`copyIgnored` setup entries must be relative paths with unused destinations; their bytes and tree identity are checked before atomic publication. Use an explicit setup command for intentional replacement of existing checkout files.

Worktrees are optional branch- and file-isolation tools, not something to recreate for every edit or every feature. One task branch should keep using its existing worktree. After entering it, inspect status again; do not assume it is clean.

If task changes already exist in a shared checkout, do not stash, reset, clean, or switch that checkout to move them. Create a new task worktree and deliberately migrate only task-owned changes, leaving unrelated and untracked user work untouched.

## Rebase or Recover

Do not rebase a shared or pre-existing checkout unless the user explicitly requests it. Before any rebase, confirm the branch and dirty state; stop on conflicts, preserve both owners' intent, and rerun affected tests. Do not use `reset --hard`, checkout-based file destruction, force push, or hook bypass without explicit user authority and a reviewed recovery plan.

## Read History

Use read-only archaeology freely:

```bash
git log -S "symbol" --oneline --all
git log -G "pattern" --oneline --all
git blame -- <relative-path>
git show <commit>
git diff <base>...<head>
```

Tie conclusions to the current implementation; history explains intent but does not override present behavior.
