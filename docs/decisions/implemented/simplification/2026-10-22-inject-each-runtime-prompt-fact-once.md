# Decision Record: Inject each runtime prompt fact once

Status: implemented

## Problem

Four runtime-owned prompt blocks restated a fact another block already carried in the same request. The environment block printed the active Workspace path twice, as `Working directory` and again as `Workspace path`. The permission profile repeated the writable-root list that the environment block already states, and both consumers called `Scope.Root.executionRoots` per model round, so every round re-read the Workspace catalog and re-acquired shared roots for the second copy. Attachment delivery guidance said the same delivery rule twice, once in the advisory response guidance and again in the `bash` tool description. Each was wasted prompt bytes on the uncached advisory path, and the double root resolution added catalog work per round.

Separately, the `<runtime-context-protocol>` block explained the `<context-source>` state vocabulary in every request, while those entries exist only in the durable observation layout used by the resolved `openai-codex` profile. Every other profile received a protocol describing markup its prompt never contains.

## Decision

`SystemPrompt.resolveWriteRoots` resolves the roots once per model round and returns both the list and any validation failure text. `SessionInvoke` resolves it before prompt assembly and passes the result to the environment block and to `ControlProfileCompiler.resolve`, so the catalog and shared-root acquisition run once. `buildPermissionContext` no longer prints a root list; the environment block owns that fact. The redundant `Workspace path` line is removed and `Working directory` remains the single statement of the active path.

A failed write-root validation keeps its explicit degradation in the environment block and skips the permission profile for that round, because compiling from an empty root list would advertise fewer capabilities with no explanation.

Attachment guidance is split by owner: the general response guidance states reference form, delivery and inspection rules, and the `bash` tool description states only what is specific to executing a command in this Workspace, without repeating the general rule. The `view_image` description no longer repeats the inspection-reference sentence.

`RuntimeAdvisory.protocol` takes the layout and returns the protocol only for the durable observation layout that emits `<context-source>` entries; the raw-text envelope layouts receive none. The retained text states the state meanings, that events are occurrences rather than present state, and that knowledge entries are immutable versions.

## Alternatives considered

**Keep the permission profile's root list as an auditable cross-check.** Two statements of one list can disagree, and nothing consumes the second copy: the permission block is prompt text, not a validator. The environment block already reports failures explicitly.

**Keep `Workspace path` because tool descriptions reference a path.** The `bash` description substitutes the same path for its default directory, and `Working directory` states it once in the environment block; a second environment line only duplicated that statement.

**Keep the protocol unconditionally because it is short.** It is 668 characters on an uncached path, and for every non-observation layout it describes `<context-source>` attributes the prompt cannot contain, which invites the model to reason about absent structure.

**Resolve roots in the environment block and let the permission profile re-read them.** This preserves the existing call shape but keeps per-round catalog reads and shared-root acquisition doubled, which was the larger cost than the text.

## Consequences

Each model round resolves write roots once and states each fact once. The advisory blocks shrink and the permission profile keeps its approval, sandbox, network and denial semantics. Failure reporting stays in one owner, so a degraded round is explained rather than silently narrowed. Tests assert the single path line, the absent permission root list, the split guidance and the layout-dependent protocol, and cover a session that switches providers mid-conversation so the protocol is asserted against the presence of an observation rather than a fixed profile.
