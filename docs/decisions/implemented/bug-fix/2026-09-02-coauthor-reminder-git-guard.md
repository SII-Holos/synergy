# Decision Record: Gate the git coauthor reminder on an actual git working tree

Status: implemented

## Problem

The coauthor footer reminder (Layer 4.55 in `session/invoke.ts`) was injected unconditionally whenever `experimental.coauthor_reminder` was not disabled. Sessions running outside a git repository (home scope, plain directories) still received "When creating git commits, always include this footer…" every turn, directly contradicting the environment block ("Is directory a git repo: no") the model saw moments earlier. The reminder is only actionable inside a git working tree, so the unconditional injection was noise at best and a prompt-cache-breaking contradiction at worst.

## Decision

`projectChannelTaskParts`-adjacent Layer 4.55 in `session/invoke.ts` now pushes the `<coauthor-reminder>` block only when both hold:

- `experimental.coauthor_reminder !== false` (unchanged opt-out), and
- the live probe `SessionProjectHealth.isGitRepo(ScopeContext.current.directory)` returns true for a `project`-type scope.

The probe is the same function the environment block uses (`system.ts`), so the reminder can never disagree with "Is directory a git repo" in the environment text. The `scope.type === "project"` short-circuit mirrors the env block exactly; home-scope sessions never pay for a git probe. When the config disables the reminder, no probe runs at all.

## Alternatives considered

- **Reuse the env block's boolean instead of probing again** — rejected: `SystemPrompt.environment` renders the result into text and does not return it to the invoke caller; threading a new return value across the parallel turn-preparation call site is a larger contract change than one extra cheap probe per turn.
- **Filter in the prompt text renderer** — rejected: the reminder is assembled in `invoke.ts`, not rendered by `system.ts`; moving it would blur the layer's ownership.
- **Keep the unconditional injection and rely on the model to ignore it** — rejected: it contradicts the env block, wastes prompt budget, and is exactly the reported symptom.

## Consequences

Non-git sessions no longer receive the coauthor footer instruction, removing the contradiction with the env block and cutting one dynamic system-prompt entry for home/plain-directory sessions. Git sessions are unaffected (probe cost is one `git rev-parse` per turn, same as the env block already pays). Tests now cover git-repo injection, explicit config opt-out, and non-git omission.
