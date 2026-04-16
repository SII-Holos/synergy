---
name: release-log-workflow
description: "Workflow for analyzing a new Synergy release from git history, drafting release notes, publishing a dedicated Feishu child document under the update-log wiki, and inserting a newest-first summary entry into the update-log index. Use when the user asks to analyze a new version, supplement 飞书更新日志, create a release child doc, update the 更新日志首页, or generate matching Wiki/GitHub release copy. Triggers: '更新日志', 'release notes', '版本更新', '补更新日志', '创建子文档', 'GitHub release', '分析 1.x.x 改动'."
---

# Release Log Workflow

## Goal

For each new release, do this in order:

1. Confirm the git range for the release
2. Analyze the final user-visible result of the commits
3. Draft release notes
4. Create a dedicated Feishu child document under the update-log wiki node
5. Insert a newest-first summary entry at the top of the update-log index page
6. Optionally generate Wiki-announcement and GitHub Release variants

## Scope discipline

Prefer the final shipped result over commit-by-commit narration.

Ignore unless user explicitly wants them:

- release script churn
- pure cleanup / deletion
- formatting-only changes
- docs-only changes
- test-only changes unless they explain a stability fix

If features changed back and forth, summarize the final outcome only.

## Repo-specific constants used in this project

For the concrete Feishu release-log layout and index pattern, see `references/feishu-template.md`.
For a quick execution checklist before publishing, see `references/release-checklist.md`.

Current Feishu update-log wiki page:

- URL: `https://sii-czxy.feishu.cn/wiki/DUT9wguAFiMl6pkFL8gcHWrmnoc`
- Wiki node token: `DUT9wguAFiMl6pkFL8gcHWrmnoc`
- Current doc token for the index page: `OGrmdkSyPoxLdrxLc9xceKH7nfd`

Use those values unless the user tells you they changed.

## Step 1: Confirm the release range

Check recent tags and commit history first.

Typical commands:

```bash
git tag --list | sort -V | tail -n 20
git log --oneline --decorate --max-count=40
```

Then identify the range, typically:

- patch release: previous tag..new tag
- medium release after cross-repo migration: may require combining predecessor and current repo ranges if user explicitly asks

## Step 2: Analyze commits

Read:

- `git show --stat --summary <commit...>` for candidate commits
- `git diff --stat <old>..<new>` for scope
- targeted `grep` / `read` on touched files when commit subjects are not enough

Produce findings in product language:

- new capabilities
- important bug fixes
- behavior changes
- upgrade notes

For each theme, prefer 1-3 concrete bullets over a giant raw commit dump.

## Step 3: Draft the main release note

Use this structure unless the user wants a different one:

- Title
- Summary
- At a Glance
- Details
- Upgrade Notes
- Fixes & Polish
- Next

Tone:

- Chinese by default when the user writes in Chinese
- medium-to-detailed for `.0` / `.x` releases
- concise for small patch releases

## Step 4: Publish a Feishu child doc

Before drafting the Feishu child doc, read `references/feishu-template.md` and match the historical style already used in this workspace.

Use `lark-cli docs +create` with `--wiki-node DUT9wguAFiMl6pkFL8gcHWrmnoc`.

Pattern:

```bash
lark-cli docs +create --title "Synergy 1.2.1" --wiki-node DUT9wguAFiMl6pkFL8gcHWrmnoc --markdown "..."
```

Important:

- Create a dedicated child doc; do NOT paste the full note directly into the update-log index page
- Capture both `doc_id` and `doc_url`
- After creation, verify with `lark-cli docs +fetch --doc "<doc_url>" --format pretty`

## Step 5: Update the index page

The update-log homepage is an index, not the full article.

Rules:

- newest entry goes at the top
- each entry contains:
  - date + version heading
  - one clickable doc link
  - 1-2 sentence summary
- preserve existing historical entries below
- use stable markdown links if `mention-doc` blocks are flaky

Pattern:

```markdown
## 2026-04-13 · 1.2.1

[Synergy 1.2.1](https://www.feishu.cn/wiki/...)

一句到两句摘要。
```

Then overwrite the index page with the full newest-first list via:

```bash
lark-cli docs +update --doc OGrmdkSyPoxLdrxLc9xceKH7nfd --mode overwrite --markdown "..."
```

## Step 6: Verify both pages

Always verify:

```bash
lark-cli docs +fetch --doc "<child_doc_url>" --format pretty
lark-cli docs +fetch --doc "https://sii-czxy.feishu.cn/wiki/DUT9wguAFiMl6pkFL8gcHWrmnoc" --format pretty
```

Check for:

- child doc exists and contains the expected sections
- index page still includes older entries
- newest version is at the top
- summary text matches the actual release

## Optional deliverables

When requested, derive two more versions from the same analysis:

- Wiki announcement version: more narrative, more announcement-like
- GitHub Release version: tighter, more structured, more concise

Do not re-analyze from scratch; reuse the same findings.

## Common pitfalls

Avoid these mistakes:

- appending the full release note into the index page
- forgetting to preserve older index entries
- writing only from commit subjects without checking code touch points
- over-indexing on cleanup / docs churn
- missing explicit user-priority themes such as memory optimization, Feishu bugs, Meta-Synergy recovery, external agents, or Holos changes

## Recommended final handoff

When done, report:

- analyzed range
- main release themes
- child doc URL
- index page updated status
- any caveats such as missing historical docs or flaky Feishu block rendering
