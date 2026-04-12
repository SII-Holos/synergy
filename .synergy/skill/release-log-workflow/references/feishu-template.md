# Feishu Update Log Templates

## Purpose

Use this file when updating the Feishu release-log wiki for Synergy.

Current project constants:

- Update-log wiki URL: `https://sii-czxy.feishu.cn/wiki/DUT9wguAFiMl6pkFL8gcHWrmnoc`
- Update-log wiki node token: `DUT9wguAFiMl6pkFL8gcHWrmnoc`
- Index page doc token: `OGrmdkSyPoxLdrxLc9xceKH7nfd`

## Child Doc Title Template

In this project, prefer the historical Feishu naming style:

- `1.2.1-20260413`
- `1.2.0-20260412` if creating from scratch
- `1.1.28-20260409`

That is: `<version>-<YYYYMMDD>`.

Do not default to `Synergy 1.2.1` for Feishu child docs in this workspace unless the user explicitly requests a different style.

## Child Doc Structure Template

Follow the historical Feishu release-note style already used in this workspace, for example `1.1.25-20250408` and `1.1.26-20250406`.

Use:

```markdown
## Summary

One or more paragraphs summarizing the release.

## At a Glance

- 4-10 bullets

## Details

### Product area or theme

#### Specific topic

Paragraphs describing final user-visible results.

### Product area or theme

#### Specific topic

Paragraphs describing final user-visible results.

## Upgrade Notes

- Important migration or behavior notes

## Fixes & Polish

- Short bullets for key fixes

## Next

- 2-3 modest forward-looking bullets
```

Notes:

- Prefer plain sectioned release notes over announcement-style callout-heavy prose
- Avoid inserting a decorative callout near the top unless the user explicitly wants it
- The Feishu child doc should read like the existing version docs, not like a marketing post

## Index Page Template

The index page is a newest-first release list.

Each entry should contain:

1. Date + version heading
2. One markdown link to the child doc
3. One short summary paragraph (1-2 sentences)

Example:

```markdown
## 2026-04-13 · 1.2.1

[Synergy 1.2.1](https://www.feishu.cn/wiki/...)

这一版聚焦在 Meta-Synergy 的安装、Holos CLI 登录和 managed mode 恢复能力。它补上了一键安装脚本和命令行登录路径，也修复了异常中断后可能残留的 orphaned managed mode 问题。
```

## Ordering Rule

Always keep the newest release at the top.

Order should look like:

- 1.2.1
- 1.2.0
- 1.1.28
- 1.1.26
- ...

## Link Format Rule

Prefer standard markdown links:

```markdown
[Synergy 1.2.1](https://www.feishu.cn/wiki/...)
```

Do not rely on `mention-doc` blocks for the index page when overwrite mode is involved. They may fail on some pages.

## Safe Publishing Pattern

1. Create child doc first
2. Capture `doc_id` and `doc_url`
3. Verify child doc content
4. Rebuild full index markdown with the new release at the top
5. Overwrite index page with the full rebuilt content
6. Verify index page again
