# Decision Record: Skill loader diagnostics name the offending frontmatter field and allowed-tools accepts YAML lists

Status: implemented

## Problem

When a `SKILL.md` frontmatter violates the skill loader's strict expectations, Synergy reported diagnostics that did not identify the offending field, so users could not fix a skill without trial-and-error. Two diagnostics were affected:

1. `skill.frontmatter_parse_failed` surfaced the raw js-yaml message (`incomplete explicit mapping pair; ... at line 3, column 435`) with no field name. An unquoted `description` value containing `: ` (e.g. `... Keywords: initialize repo ...`) triggers this — the strict YAML parse is technically correct, but Claude Code and Gemini CLI load the same file leniently, so the failure was confusing.
2. `skill.manifest_invalid` surfaced only the zod message (`Invalid input: expected string, received array`) with no field name. `allowed-tools` written as a YAML list was rejected even though Claude Code's official documentation accepts a YAML list for that field and community skills commonly use the list form.

A third latent defect amplified the confusion: gray-matter caches every parsed input by content before parsing, so a file whose frontmatter failed to parse was cached as `data: {}`. The same broken `SKILL.md` re-parsed on the next reload silently produced `skill.manifest_invalid` (missing `name`/`description`) instead of `skill.frontmatter_parse_failed`, so the diagnostic drifted between reloads.

## Decision

`SkillManifest.normalizeFile` now builds diagnostics that name the offending field and give a concrete fix hint, and `allowed-tools` accepts both forms:

- `skill.frontmatter_parse_failed` reads the original `YAMLException` from the `FrontmatterError` cause chain, walks `mark.position` backward over the frontmatter block to find the nearest line-leading `key:` (the `mark.buffer` is the frontmatter block, so positions are already relative to it), and emits `Failed to parse YAML frontmatter in field '<field>': <detail>. Tip: quote values containing ': ' with double quotes, e.g. description: "Keywords: foo".` When no field can be located it falls back to the original message. The diagnostic `reason` additionally carries `line`, `column`, `position`, and `field` when available.
- `skill.manifest_invalid` messages are generated per zod issue: `Invalid field '<path>': expected <expected>, received <received>` for `invalid_type` (deriving `received` from the input via a small `describeInput` helper), a readable union summary for `invalid_union`, `Invalid field '<path>': unknown field(s) 'a', 'b'` for `unrecognized_keys`, and the original message appended for other codes. `normalizeProgrammatic` shares the same helpers. The `reason` carries `expected`/`received` for `invalid_type` and `keys` for `unrecognized_keys`.
- The `allowed-tools` schema field is `z.union([z.string(), z.array(z.string())]).optional()`. The lenient normalization path joins a list with spaces so both forms normalize to the same space-separated string. `allowed-tools` still never becomes runtime authorization state: the normalized record does not preserve it.
- `ConfigMarkdown.parse` passes an explicit `{}` options object to gray-matter, which disables gray-matter's content cache, so a broken frontmatter keeps throwing `FrontmatterError` on every parse instead of being cached as `data: {}`.

The shared `ConfigMarkdown.parse` error message structure is unchanged (`Failed to parse YAML frontmatter: ...` with the cause chain intact), so the config-loader, CLI error presentation, and archive import consumers are untouched.

## Alternatives considered

- **Add a new structured `hint` field to the Diagnostic schema** — rejected: `message` is the only channel the whole pipeline renders (reload mapping drops `field`/`reason`, the App renders only `message`, the skill tool interpolates only `message`). Adding a field would require server/SDK contract changes for no user-visible gain.
- **Keep `allowed-tools` string-only and only improve diagnostics** — rejected: Claude Code (the field's origin implementation) officially accepts a YAML list, community analysis found inline lists to be the most common form among skills that set the field, and accepting both is a pure superset with no behavior break for string authors.
- **Replace gray-matter or switch to a lenient YAML parser** — rejected: that would silently accept malformed frontmatter and change parsing behavior for every `ConfigMarkdown` caller (commands, agents, skills). The actual defect was the cache causing diagnostic drift; disabling the cache keeps strict parsing intact.

## Consequences

Skill diagnostics now tell the user which field failed, what was expected, and how to fix it, and skills written with `allowed-tools: [Read, Write]` load in both strict and lenient sources. A broken `SKILL.md` reports `skill.frontmatter_parse_failed` consistently across reloads. The type widening is backward compatible (string authors see no change), and no runtime authorization semantics were introduced. The only cost is that `ConfigMarkdown.parse` no longer benefits from gray-matter's in-process content cache — irrelevant for the small per-file markdown definitions it loads.
