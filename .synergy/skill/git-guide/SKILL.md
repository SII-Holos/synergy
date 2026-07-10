---
name: git-guide
description: "Git expert for commits, rebase, and history search. Use for: atomic commits (auto-detects style from repo), rebase/squash, history archaeology (blame, bisect, log -S). Triggers: 'commit', 'rebase', 'squash', 'who wrote', 'when was X added', 'find the commit that', 'git blame'."
---

# Git Guide for Synergy Development

## Safety Rules

These rules exist to protect concurrent sessions and CI stability. The permission system enforces them automatically — do not attempt to bypass.

| Rule                                                                    | Enforcement                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Never `git checkout` / `git switch` on the main checkout                | `shell_branch_mutation` → deny in autonomous                                                                                                                                                                                                                                   |
| Never `git push` from the main checkout                                 | `shell_remote_publish` → upgraded to `shell_remote_write` → deny in autonomous                                                                                                                                                                                                 |
| Never commit or push from the main checkout                             | Only make commits and push from a worktree. The main checkout is shared infrastructure; a commit may accidentally include unrelated changes from concurrent sessions, and a push can break CI for every branch built on the primary branch.                                    |
| Always use a worktree for commits and pushes                            | `worktree_enter` required                                                                                                                                                                                                                                                      |
| Changes reach the primary branch only through PRs, never by direct push | Determine the repo's primary branch first — it is not always `main` or `master`. Check `git remote show origin` or the GitHub default branch. For this Synergy repo: **`dev`**. Pushing directly to the primary branch can break CI for every other branch that depends on it. |

For this repo, the primary branch is **`dev`**. All changes reach `dev` through pull requests only.

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

# 4. Push (only from a worktree!)
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

### 1. Create PRs from a worktree only

Never `gh pr create` from the main checkout. Use `worktree_enter` first.

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

| Command                              | Autonomous                                         |
| ------------------------------------ | -------------------------------------------------- |
| `gh pr view/list/status/checks/diff` | ✅ allow (read)                                    |
| `gh pr create`                       | ✅ allow (`shell_remote_publish`)                  |
| `gh pr comment` / `gh pr review`     | ⚠️ blocked on main checkout (`shell_remote_write`) |
| `gh issue view/list`                 | ✅ allow (read)                                    |
| `gh issue create/comment`            | ⚠️ blocked on main checkout (`shell_remote_write`) |
| `gh pr merge/close`                  | ❌ deny (`shell_destructive`)                      |

For operations blocked on the main checkout, use a worktree.

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

Use `git rebase` only in a worktree. `git rebase` is classified as `shell_destructive` and is denied in autonomous mode on the main checkout.

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
