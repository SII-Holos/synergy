---
name: git-guide
description: Safely inspect Synergy git history, create or reuse task worktrees and topic branches, stage focused changes, write redacted agent commit messages, rebase, push, or open pull requests. Use for git status, blame, archaeology, commits, branches, worktrees, protected branches, rebases, pushes, PR preparation, GitHub publication, GitHub CLI permission classification, or agent co-author rules in this shared repository.
---

# Git Guide for Synergy Development

Inspect status, current branch and worktree ownership before editing or any Git mutation. Direct edits are allowed; preserve unrelated dirty and untracked files. Reuse an existing task worktree when it owns the branch. Do not switch or rebase a shared or pre-existing checkout without the user's explicit request. Do not stash, reset or clean shared work to move your changes.

Stage, commit, push, create a PR or mutate external systems only when the user requests that action. Do not use destructive Git commands, force pushes or hook bypasses without explicit authority and a reviewed recovery plan. Amend only your own unpushed task commit when requested or a hook modified intended content; never rewrite someone else's work.

Every agent-created commit ends with:

```text
Co-authored-by: synergy-agent <299070056+synergy-agent@users.noreply.github.com>
```

## Protect Branches and Scope

- Never push directly to the protected `dev` or `main` branches.
- Local commits on `dev` or `main` are permitted when the user requests them, but they advance a potentially shared branch. Publish through a topic branch and open a pull request against `dev`.
- The release workflow is the only path from `dev` to `main`.
- Inspect `git status` before editing, staging, committing, rebasing, or publishing.
- Preserve unrelated dirty and untracked files. Stage only explicit files owned by the current task.

## Keep Internal Data Out of Outbound Text

Never expose the following in a commit message, pull-request body, issue/PR comment, or review:

| Category                   | Forbidden content                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Local filesystem paths     | absolute home/project paths or home-relative checkout paths                               |
| Synergy runtime paths      | `.synergy` homes, temporary runtime/worktree locations, or `SYNERGY_HOME` values          |
| Session and Scope identity | session IDs, Scope IDs, or equivalent internal identifiers                                |
| Logs and diagnostics       | local log paths, raw logs, traces, and diagnostic artifacts                               |
| Credentials                | auth/config-store paths, API keys, tokens, secrets, or secret-like values                 |
| Internal configuration     | provider endpoints, MCP addresses, private service URLs, or equivalent deployment details |

Project-relative source paths such as `packages/local-runtime/src/tools/read.ts` are allowed. Redact or summarize sensitive evidence before it enters any outbound GitHub surface.

## Read the Relevant Procedure

Before performing a listed operation, read its reference. Routine status/diff inspection does not require unrelated procedures.

| Operation                                                                                 | Required reference                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Create/reuse/move a worktree, branch isolation, rebase/recovery or history investigation  | [Worktrees and history](references/worktrees.md) |
| Stage/commit, prepare/publish/review a PR, or handle checks                               | [Commits and PRs](references/commits-and-prs.md) |
| Change gh capability classification, troubleshoot credentials or sandboxed authentication | [GitHub CLI](references/github-cli.md)           |
| Change Oryn workflows, CI planning/inputs, publication retries or runtime pins            | [Automation and CI](references/automation-ci.md) |

## Handoff

Report the checkout and branch, whether a worktree was used, files staged or committed, commit hash if created, checks run, push/PR result if requested, and any preserved unrelated changes.
