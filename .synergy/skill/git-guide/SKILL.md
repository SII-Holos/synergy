---
name: git-guide
description: "Git expert for commits, rebase, and history search. Use for: atomic commits (auto-detects style from repo), rebase/squash, history archaeology (blame, bisect, log -S). Triggers: 'commit', 'rebase', 'squash', 'who wrote', 'when was X added', 'find the commit that', 'git blame'."
---

# Git Guide for Synergy Development

## Safety Rules

These rules protect concurrent sessions and keep CI as the merge gate:

- Never push directly to the protected branches `dev` or `main`. Commit repository changes on a topic branch and open a pull request against `dev`.
- Do not run `git checkout` or `git switch` in a shared or pre-existing checkout. A branch change affects every session using that working directory. Create or enter a worktree when the task needs another branch.
- Treat worktrees as branch-isolation tools, not as a requirement for every edit or every feature. Continue in an existing task-owned checkout when it is already on the correct branch, and reuse its worktree for later changes to the same branch.
- Inspect `git status` before editing or staging. Preserve unrelated changes and stage only the current task's files.
- Publish only from the task's topic branch. The autonomous profile permits ordinary remote publication from worktrees and denies remote writes from the shared checkout, so enter the task's worktree before pushing or creating a pull request.

For this repo, pull requests target **`dev`**. The release workflow is the only path from `dev` to **`main`**.

## Commit Message Rules

### 1. Never expose local paths or internal data

**Forbidden in any commit message, PR body, comment, or review:**

| Category                  | Examples of what NOT to expose                                      |
| ------------------------- | ------------------------------------------------------------------- |
| Local filesystem paths    | `/Users/eric/projects/synergy/src/foo.ts`, `~/projects/synergy/`    |
| Synergy internal paths    | `~/.synergy/`, `/tmp/synergy-pr/`, `SYNERGY_HOME=/tmp/synergy-dev`  |
| Session/scope identifiers | `ses_0b6db81cffetoxJdStRQdIVE5`, `scopeID=e2f7f212...`              |
| Log paths                 | `~/.synergy/log/dev.log`, `~/.synergy/state/daemon/logs/server.log` |
| Auth or credential paths  | `~/.synergy/data/auth/`, `~/.synergy/config/synergy.d/`             |
| API keys or tokens        | Any key, token, or secret value                                     |
| Internal config details   | Provider endpoint URLs from config, MCP server addresses            |

Project-relative paths are fine: `packages/synergy/src/tool/read.ts` ✓

### 2. Write meaningful, concise messages

```
<type>: <imperative summary>

<optional body — what and why, not how>

Co-authored-by: synergy-agent <299070056+synergy-agent@users.noreply.github.com>
```

Types match the repo's existing conventions: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `perf:`, `chore:`.

### 3. Always include the co-author footer

Every commit created by the agent must end with:

```
Co-authored-by: synergy-agent <299070056+synergy-agent@users.noreply.github.com>
```

## Commit Workflow

### Step-by-step

```bash
# 1. Review what will be committed
git status
git diff --stat
git log --oneline -5              # match existing commit style

# 2. Stage only relevant files — never .env, credentials, config with secrets
git add <specific files>

# 3. Commit
git commit -m "type: summary" -m "details if needed"

# 4. Push the topic branch from its worktree
git push -u origin HEAD
```

### Before committing, always run:

```bash
bun run quality:quick   # format:check + lint + typecheck + monorepo:check + package:check
```

### Files to NEVER commit

- `.env`, `.env.local`, `.env.*`
- `credentials.json`, `*-credentials.*`
- Any file containing API keys, tokens, or secrets
- `~/.synergy/` paths or contents
- Internal tool logs or trace files

## Pull Request Rules

### Reviewed outbound content

When a PR body, issue body, commit message, or other outbound text needs user review, use a Note as the editable intermediate artifact. After the user has reviewed or edited it, pass the Note to a file-consuming command through the local Bash virtual path:

```bash
gh pr create --body-file /synergy/note/<note-id>
gh issue comment 123 --body-file /synergy/note/<note-id>
git commit -F /synergy/note/<note-id>
```

Do not interpolate Note content into the command. Local Bash materializes the virtual path as a private, owner-readable file for the lifetime of the process and grants the sandbox read access to its staging directory, so shell metacharacters in the Note remain file content. The receiving CLI still owns the semantics of the file it reads; do not pass a Note to an option that executes or interprets the file as code. Synergy Link commands remain remote and receive virtual paths unchanged.

### 1. Create PRs from the topic branch

Verify that the current branch is neither `dev` nor `main`. In an autonomous session, enter the topic branch's worktree before running `gh pr create`, because remote publication is denied from the shared checkout.

### 2. PR body must not contain local data

Same rules as commit messages: no local paths, no session IDs, no internal config.

Good PR body:

```
## Summary
- Fixed session compaction edge case when rootID is unset
- Added test for multi-part streaming

## Test plan
- `bun test test/session/compaction.test.ts`
- `bun run quality:quick`
```

Bad PR body:

```
Fixed the bug in /Users/eric/projects/synergy/packages/synergy/src/session/compaction.ts
Tested with session ses_abc123 on scope e2f7f212...
```

Use project-relative paths: `packages/synergy/src/session/compaction.ts` ✓

### 3. PR comments and reviews

When commenting on PRs, reviews, or issues:

- Use project-relative paths to refer to files
- Never paste session logs or trace output containing local paths
- Never paste internal config or credential details
- If a stack trace or error message contains local paths, summarize instead of pasting

### Creating a PR from a worktree

```bash
# After pushing the feature branch:
gh pr create --title "type: summary" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
- <verification commands>
EOF
)"
```

## GitHub CLI (`gh`) Usage

The `gh` command is classified by the permission system:

| Command                              | Autonomous                                   |
| ------------------------------------ | -------------------------------------------- |
| `gh pr view/list/status/checks/diff` | ✅ allow (read)                              |
| `gh pr create`                       | ✅ allow (`shell_remote_publish`)            |
| `gh pr comment` / `gh pr review`     | ⚠️ remote write; denied by autonomous policy |
| `gh issue view/list`                 | ✅ allow (read)                              |
| `gh issue create/comment`            | ⚠️ remote write; denied by autonomous policy |
| `gh pr merge/close`                  | ❌ deny (`shell_destructive`)                |

Worktrees isolate branch publication, but they do not turn broader remote-write operations into ordinary publication. Follow the active control profile for comments, reviews, issues, merges, and closes.

## Amending and Rebasing

### Amend only when ALL conditions are met

1. HEAD commit was created by you in this conversation (verify: `git log -1 --format='%an %ae'`)
2. Commit has NOT been pushed to remote (verify: `git status` shows "Your branch is ahead")
3. Amend reason: pre-commit hook auto-modified files, OR user explicitly requested

### Never amend if

- Commit was pushed to remote
- Commit was created by someone else
- Commit was created in a different session
- Pre-commit hook rejected the commit (fix the issue and create a NEW commit instead)

### Rebase

Rebase only a task-owned topic branch in an isolated checkout. `git rebase` is classified as `shell_destructive` and is denied in autonomous mode regardless of checkout type.

## History Archaeology

Agent is encouraged to use these read-only commands freely:

```bash
git log --oneline -20
git log -S "search term"           # find commits that added/removed code
git blame packages/synergy/src/tool/read.ts
git show <commit>
git diff HEAD~3..HEAD
git log --all --oneline --grep="keyword"
```

## Key Files

| File                                      | Purpose                                 |
| ----------------------------------------- | --------------------------------------- |
| `AGENTS.md`                               | Practical Working Rules (authoritative) |
| `.synergy/skill/develop-synergy/SKILL.md` | Isolated dev instance workflow          |
| `.synergy/skill/testing-guide/SKILL.md`   | Pre-commit quality and test workflow    |
