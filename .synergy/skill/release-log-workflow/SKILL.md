---
name: release-log-workflow
description: Analyze a Synergy release range, draft user-facing release notes, publish a dedicated Feishu update-log child document, update the newest-first index, or derive Wiki and GitHub Release variants. Use for release notes, 更新日志, version summaries, Feishu release pages, index updates, and GitHub release copy.
---

# Produce a Release Log

## Set the Scope

1. Confirm the release version, previous comparison point, repository range, date, language, target surfaces, and whether publication is requested.
2. Read `references/release-checklist.md`. Before any Feishu write, also read `references/feishu-template.md` for the current node, title, and index contract.
3. Do not publish, edit the index, create a GitHub release, or send an announcement when the user asked only for analysis or a draft.

## Establish the Shipped Delta

```bash
git tag --list --sort=-version:refname | head -20
git log --oneline --decorate <previous>..<release>
git diff --stat <previous>..<release>
```

Inspect ambiguous commits with `git show`, targeted diffs, tests, and current product docs. Group the final shipped behavior by product area. Exclude formatting, release mechanics, tests, docs, and implementation churn unless they explain a user-visible capability, compatibility change, or reliability fix.

## Draft Once

Create one evidence-backed source note with:

- title and short summary
- at-a-glance changes
- details grouped by product theme
- upgrade or migration notes
- fixes and polish
- restrained next steps when appropriate

Describe final behavior rather than commit chronology. Verify product names against [Product overview](../../../docs/product/overview.md) and current terminology against [Documentation](../../../docs/README.md).

Derive shorter Wiki-announcement or GitHub Release versions from the same findings; do not re-analyze the range separately.

## Publish to Feishu When Authorized

1. Fetch the current index before writing and preserve every prior entry.
2. Create a dedicated child document under the configured update-log wiki node using the title format in `feishu-template.md`.
3. Fetch the child document and verify its title, sections, links, and content.
4. Insert one date/version/link/summary entry at the top of the full index document.
5. Overwrite the index only with the complete newest-first content.
6. Fetch the index again and verify the new entry, prior entries, order, and child link.

Prefer the available Feishu document/knowledge tools. If the environment exposes `lark-cli`, use its document create, fetch, and update commands as shown in the reference. Never treat a successful write response as final verification.

## Handoff

Report the analyzed range, main themes, excluded noise, draft or published surfaces, child-document URL, index verification, and any missing tag, artifact, or release evidence. Do not expose local paths, private tokens, or unrelated Feishu content.
