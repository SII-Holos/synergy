# Decision Record: Remove shell expansion from command templates

Status: implemented

## Problem

`CommandRenderer.render` (`packages/synergy/src/command/renderer.ts`) expanded `!`command``shell expressions found in command templates by executing them directly with Bun's`$` shell. The command text comes from user-editable template files (`.synergy/commands/**/\*.md`, `{command,commands}/**/\*.md`under config roots, and`70-commands.jsonc`) and ran with the server process's full privileges — no sandbox, no capability classification, no approval gate. This bypassed the centralized enforcement boundary (`enforcement/gate.ts`+`permission/`) that every other shell-execution path (e.g. the `bash` tool) crosses. A command template copied from an untrusted source executed its shell expressions with full privileges the first time the command rendered. No in-repo template, documentation, UI, or SDK surface used the feature, and no test locked the expansion behavior.

## Decision

Remove the shell-expansion stage from `CommandRenderer.render` entirely. Command templates are prompt text: `!`command`` shell syntax stays literal and is never executed during rendering, matching Skill rendering (`SkillRenderer`), which already keeps the syntax literal. The now-unused `ConfigMarkdown.shell`helper and`SHELL_REGEX`were removed with it.`CommandRenderer.render` keeps its async signature so callers are unchanged.

## Alternatives considered

- **Route expansion through the enforcement gate as a shell-execution capability** — rejected: `CommandRenderer.render` runs in the command-invocation path (`session/invoke.ts` `command()`), outside the tool-execution context that carries the approval and sandbox plumbing. Retrofitting the gate would be a substantial architecture change and would still leave template shell syntax as a hidden execution surface with no consumer.
- **Gate template shell expansion behind an explicit per-command/scope opt-in config flag (default off)** — rejected: no consumer exists in the repository or documented surface. An opt-in flag would preserve a permission-system bypass for any future template author and add config surface without a user.

## Consequences

`!`command``in a command template is now passed through to the model as literal text instead of being executed and substituted. This is a behavior change for any template that relied on expansion (none exist in the repository; the Skill renderer already treats the syntax literally, so command templates now match). Template authors who need computed values must use the`bash` tool, which crosses the enforcement gate like any other shell execution.
