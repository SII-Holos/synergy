---
name: git-guide
description: Safely inspect Synergy git history, create or reuse task worktrees and topic branches, stage focused changes, write redacted agent commit messages, rebase, push, or open pull requests. Use for git status, blame, archaeology, commits, branches, worktrees, protected branches, rebases, pushes, PR preparation, GitHub publication, GitHub CLI permission classification, or agent co-author rules in this shared repository.
---

# Git Guide for Synergy Development

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

Worktrees are optional branch- and file-isolation tools, not something to recreate for every edit or every feature. One task branch should keep using its existing worktree. After entering it, inspect status again; do not assume it is clean.

If task changes already exist in a shared checkout, do not stash, reset, clean, or switch that checkout to move them. Create a new task worktree and deliberately migrate only task-owned changes, leaving unrelated and untracked user work untouched.

## Protect Branches and Scope

- Never push directly to the protected `dev` or `main` branches.
- Local commits on `dev` or `main` are permitted when the user requests them, but they advance a potentially shared branch. Publish through a topic branch and open a pull request against `dev`.
- The release workflow is the only path from `dev` to `main`.
- Inspect `git status` before editing, staging, committing, rebasing, or publishing.
- Preserve unrelated dirty and untracked files. Stage only explicit files owned by the current task.

## Make a Focused Commit

Commit, stage, push, or create a PR only when the user requests that action.

1. Review `git diff`, `git diff --stat`, and untracked files.
2. Run the narrow tests plus `bun run quality:quick` in proportion to the change.
3. Stage explicit task paths. Never stage secrets, local config, logs, traces, diagnostics, runtime data, or unrelated user work.
4. Re-read `git diff --cached`.
5. Write a concise conventional commit using an imperative summary. Allowed types follow repository convention: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `perf:`, and `chore:`.
6. Explain what and why in an optional body, not a step-by-step account of how.
7. End every agent-created commit with the exact co-author footer:

```text
<type>: <imperative summary>

<optional body — what and why, not how>

Co-authored-by: synergy-agent <299070056+synergy-agent@users.noreply.github.com>
```

Do not amend a commit unless it was created in this task, has not been pushed, and the user requested amendment or a hook modified the intended content. Never rewrite someone else's work.

### Keep internal data out of outbound text

Never expose the following in a commit message, pull-request body, issue/PR comment, or review:

| Category                   | Forbidden content                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Local filesystem paths     | absolute home/project paths or home-relative checkout paths                               |
| Synergy runtime paths      | `.synergy` homes, temporary runtime/worktree locations, or `SYNERGY_HOME` values          |
| Session and Scope identity | session IDs, Scope IDs, or equivalent internal identifiers                                |
| Logs and diagnostics       | local log paths, raw logs, traces, and diagnostic artifacts                               |
| Credentials                | auth/config-store paths, API keys, tokens, secrets, or secret-like values                 |
| Internal configuration     | provider endpoints, MCP addresses, private service URLs, or equivalent deployment details |

Project-relative source paths such as `packages/synergy/src/tool/read.ts` are allowed. Redact or summarize sensitive evidence before it enters any outbound GitHub surface.

## Push and Open a PR

1. Confirm the current branch is a non-protected topic branch and inspect the exact push target. Publication does not require a worktree.
2. Push only the topic branch; never push `dev` or `main` directly.
3. Open the pull request against `dev`.
4. Use project-relative paths and redacted evidence in the PR body.
5. State the summary and exact test commands. Do not claim checks that were not run.
6. Use a reviewed Note as the file input when outbound content requires user editing:

```bash
git commit -F /synergy/note/<note-id>
gh pr create --body-file /synergy/note/<note-id>
gh issue comment <number> --body-file /synergy/note/<note-id>
```

Do not interpolate Note contents into a shell command or pass them to an option that executes the file as code.

The `autonomous` profile permits ordinary topic-branch and pull-request publication from either the primary checkout or a worktree. Protected-branch pushes and broader remote mutations remain `shell_remote_write` and are denied. This capability boundary does not replace the user's authorization to publish.

## GitHub CLI Permission Matrix

The permission system classifies `gh` commands before applying the active control profile. The table shows the base profile decision before user rules, approval cache, SmartAllow, GitHub authorization, or ordinary runtime failures.

| Command                              | Capability             | Guarded  | Autonomous | Full Access |
| ------------------------------------ | ---------------------- | -------- | ---------- | ----------- |
| `gh pr view/list/status/checks/diff` | `shell_read`           | ✅ allow | ✅ allow   | ✅ allow    |
| `gh pr create`                       | `shell_remote_publish` | ⚠️ ask   | ✅ allow   | ✅ allow    |
| `gh pr comment` / `gh pr review`     | `shell_remote_publish` | ⚠️ ask   | ✅ allow   | ✅ allow    |
| `gh pr edit` / `gh pr ready`         | `shell_remote_write`   | ⚠️ ask   | ❌ deny    | ✅ allow    |
| `gh issue view/list/status`          | `shell_read`           | ✅ allow | ✅ allow   | ✅ allow    |
| `gh issue create/comment`            | `shell_remote_publish` | ⚠️ ask   | ✅ allow   | ✅ allow    |
| `gh issue edit/close/reopen`         | `shell_remote_write`   | ⚠️ ask   | ❌ deny    | ✅ allow    |
| `gh pr merge/close/reopen`           | `shell_destructive`    | ⚠️ ask   | ❌ deny    | ✅ allow    |

Checkout type does not change ordinary `shell_remote_publish` into `shell_remote_write`. Unknown write-capable `gh` subcommands default to `shell_remote_write`. Full Access silently allows permission-system capabilities but does not override task authorization, protected-branch rules, GitHub permissions, validation failures, or network/runtime errors.

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

## Handoff

Report the checkout and branch, whether a worktree was used, files staged or committed, commit hash if created, checks run, push/PR result if requested, and any preserved unrelated changes.
