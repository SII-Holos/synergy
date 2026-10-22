# Decision Record: Inject each runtime prompt fact once

Status: implemented

## Problem

Four runtime-owned prompt blocks restated a fact another block already carried in the same request. The environment block printed the active Workspace path twice, as `Working directory` and again as `Workspace path`. The permission profile repeated the writable-root list that the environment block already states, and both consumers called `Scope.Root.executionRoots` per model round, so every round re-read the Workspace catalog and re-acquired shared roots for the second copy. Attachment delivery guidance said the same delivery rule twice, once in the advisory response guidance and again in the `bash` tool description. Each was wasted prompt bytes on the uncached advisory path, and the double root resolution added catalog work per round.

A fifth duplication lived in the agent prompts themselves. `developer/base.txt` carried its own `## Sharing progress updates` section while `withPreambleSection` appended the shared `## Progress Updates` policy to every prompt that lacks that heading, so the developer subagent received both. The two disagreed: the private section told the agent to announce work before starting it, which the shared policy forbids as narration of routine steps. No test covered the developer prompt, so the drift was invisible.

Separately, the `<runtime-context-protocol>` block explained the `<context-source>` state vocabulary in every request, while those entries exist only in the durable observation layout used by the resolved `openai-codex` profile. Every other profile received a protocol describing markup its prompt never contains.

## Decision

`SystemPrompt.resolveWriteRoots` resolves the roots once per model round and returns both the list and any validation failure text. `SessionInvoke` resolves it before prompt assembly and passes the result to the environment block and to `ControlProfileCompiler.resolve`, so the catalog and shared-root acquisition run once. `buildPermissionContext` no longer prints a root list; the environment block owns that fact. The redundant `Workspace path` line is removed and `Working directory` remains the single statement of the active path.

A failed write-root validation keeps its explicit degradation in the environment block and skips the permission profile for that round, because compiling from an empty root list would advertise fewer capabilities with no explanation.

Attachment guidance is split by owner: the general response guidance states reference form, delivery and inspection rules, and the `bash` tool description states only what is specific to executing a command in this Workspace, without repeating the general rule. The `view_image` description no longer repeats the inspection-reference sentence.

The private `## Sharing progress updates` section is removed from `developer/base.txt`, leaving the shared policy as the single source for every agent prompt. `progress-guidance.test.ts` now assembles every `agent/prompt/*/base.txt` through `withPreambleSection` and asserts exactly one progress-policy heading, so a future prompt that words its own policy differently fails instead of silently shipping two.

`RuntimeAdvisory.protocol` takes the layout and returns the protocol only for the durable observation layout that emits `<context-source>` entries; the raw-text envelope layouts receive none. The retained text states the state meanings, that events are occurrences rather than present state, and that knowledge entries are immutable versions.

## Alternatives considered

**Keep the permission profile's root list as an auditable cross-check.** Two statements of one list can disagree, and nothing consumes the second copy: the permission block is prompt text, not a validator. The environment block already reports failures explicitly.

**Keep `Workspace path` because tool descriptions reference a path.** The `bash` description substitutes the same path for its default directory, and `Working directory` states it once in the environment block; a second environment line only duplicated that statement.

**Keep the protocol unconditionally because it is short.** It is 668 characters on an uncached path, and for every non-observation layout it describes `<context-source>` attributes the prompt cannot contain, which invites the model to reason about absent structure.

**Resolve roots in the environment block and let the permission profile re-read them.** This preserves the existing call shape but keeps per-round catalog reads and shared-root acquisition doubled, which was the larger cost than the text.

**Let each agent prompt keep its own progress section and skip the shared injection for it.** Two policies would still reach the model, and the private one contradicts the surviving shared rule about not narrating routine steps; the injection is also idempotent only on its own heading.

## Consequences

Each model round resolves write roots once and states each fact once. The advisory blocks shrink and the permission profile keeps its approval, sandbox, network and denial semantics. Failure reporting stays in one owner, so a degraded round is explained rather than silently narrowed. Tests assert the single path line, the absent permission root list, the split guidance and the layout-dependent protocol, and cover a session that switches providers mid-conversation so the protocol is asserted against the presence of an observation rather than a fixed profile. The progress-policy test now covers every agent prompt rather than the three primary ones, which is what would have caught the developer drift.
