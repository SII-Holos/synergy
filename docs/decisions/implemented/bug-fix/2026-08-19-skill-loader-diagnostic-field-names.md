# Decision Record: Skill loader diagnostics name the offending frontmatter field

Status: implemented

## Problem

When a `SKILL.md` frontmatter violates the skill loader's strict expectations, the reported diagnostics did not identify the offending field, so users could not fix a skill without trial-and-error. `skill.frontmatter_parse_failed` surfaced only the raw js-yaml message (a column number and a generic YAML reason), and `skill.manifest_invalid` carried the field only in the diagnostic's structured `field` property — but every user-facing surface (Library view, `skill` tool output, reload results, `script/skill-check.ts`) renders only `message`, so the field never reached the user. Both failure paths were hit with a skill that loads fine in Claude Code and Gemini CLI: an unquoted `description` containing `: ` and `allowed-tools` written as a YAML list.

## Decision

Both diagnostics now embed the field name and a concrete fix hint in the message text itself, so every rendering surface improves without per-surface changes.

- `skill.frontmatter_parse_failed` extracts the offending field from the js-yaml `YAMLException` mark (the marked line's key), reports the file line/column in the message and structured `reason`, and when the value contains an unquoted `: ` suggests quoting it with double quotes including a corrected example. The diagnostic also sets the structured `field` property.
- `skill.manifest_invalid` prefixes the zod message with the field path (`Field '<path>': ...`), keeps `field` on the diagnostic, and adds `expected`/`field` to `reason`. For `allowed-tools` type failures it appends the agentskills.io contract hint (`Use a space-separated string per agentskills.io, e.g. allowed-tools: Read Write`).
- `allowed-tools` written as a YAML list of strings is accepted and normalized to the space-separated string form before schema validation, matching Claude Code and Gemini CLI leniency while preserving the documented contract that `allowed-tools` is descriptive metadata with no authorization effect. Non-string lists still fail with the field-named diagnostic.

## Alternatives considered

- **Render the existing structured `field` property in the app surfaces** — rejected: it would require touching the Library view, the `skill` tool, reload result rendering, and the check script, and the structured property is already dropped by several surfaces; embedding the field in `message` fixes all surfaces at once and keeps diagnostics readable in logs.
- **Reject the YAML list form of `allowed-tools` and only improve the message** — rejected: the list form is accepted by Claude Code and Gemini CLI, so rejecting it keeps the confusing cross-tool failure the issue reports; normalizing it is a zero-risk metadata-only change because `allowed-tools` never creates runtime authorization state.

## Consequences

Users see which frontmatter field broke and how to fix it in every diagnostic surface (Library panel, reload results, `skill` tool, skill-check script), with a corrected example for the common unquoted `: ` case. Skills written for Claude Code and Gemini CLI that use the `allowed-tools` list form now load in Synergy without diagnostics. The normalization is intentionally narrow: only an array of strings is joined; mixed or non-string lists still surface the field-named `manifest_invalid` diagnostic pointing at the agentskills.io string contract.
