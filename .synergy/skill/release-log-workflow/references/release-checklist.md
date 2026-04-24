# Release Checklist

## Before analysis

- Confirm the release tag exists
- Confirm the previous comparison point
- Confirm whether analysis spans one repo or predecessor + current repo
- Check whether the user wants only Feishu, or also Wiki / GitHub Release variants

## During analysis

- Read recent tags and commit history
- Check `git show --stat --summary` for the release commits
- Check `git diff --stat <old>..<new>` for scope
- Read touched files when commit subjects are ambiguous
- Filter out cleanup / docs / formatting / release-only noise unless it affects shipped behavior
- Summarize final outcomes, not implementation churn

## Drafting

- Lead with what changed for users
- Group by product themes, not commit chronology
- Mention key bug fixes explicitly
- Include upgrade notes when behavior changed
- Keep tone consistent with the target surface:
  - Feishu child doc: fuller release note
  - Index page: concise summary
  - Wiki announcement: more narrative
  - GitHub Release: tighter and more structured

## Feishu publish

- Create child doc under wiki node `DUT9wguAFiMl6pkFL8gcHWrmnoc`
- Use the historical title style `<version>-<YYYYMMDD>` such as `1.2.1-20260413`
- Verify child doc via `docs +fetch`

## Index update

- Rebuild the full index, do not append blindly if overwrite is safer
- Put newest release at the top
- Preserve all older entries below
- Each entry should have date, link, and 1-2 sentence summary
- Prefer markdown links over `mention-doc` when block insertion is flaky
- Verify index page after update

## Final handoff

Report these items back to the user:

- analyzed range
- main release themes
- new child doc URL
- whether the update-log index was updated successfully
- any caveats, such as missing historical docs or flaky Feishu block rendering

## Common failure modes

- Writing the full release note into the index page
- Forgetting to preserve older releases in the index
- Reporting every commit instead of the final product outcome
- Missing user-priority topics such as memory optimization or recovery bugs
- Publishing the child doc but forgetting to insert the index entry
- Updating the index with an unstable doc-reference block that later fails to render
