# Decision Record: Compact catalogs and version-safe memory curation

Status: implemented

## Problem

Model requests carry repeated catalog syntax and MCP tool-ID prefixes even when tool definitions are deferred. Always-recalled memories can also accumulate incident narratives and temporary status when agents interpret editing an existing entry as appending more history. Anima and Chronicler already own reflection and memory maintenance, but the injected entries lack editable IDs and revision metadata, and embedding preparation separates a memory read from an unconditional write that can overwrite an intervening correction.

## Decision

The [Skill tool](../../../../packages/local-runtime/src/tools/skill.ts) renders each accessible name and current displayed description on one line. The [tool resolver](../../../../packages/harness/src/session/tool-resolver.ts) factors a verified common MCP ID prefix out of its group directory while retaining every name. This changes only model-facing representation: permissions, complete tool IDs, schemas, discovery, expansion and default exposure stay unchanged. A missing shared prefix must not remove or rewrite a tool ID.

The [shared memory guidance](../../../../packages/library/src/agent-prompts.ts), [Chronicler prompt](../../../../packages/library/src/prompts/chronicler.txt) and [Anima contribution](../../../../packages/anima/src/agent-prompts.ts) maintain durable rules rather than growing incident logs. They preserve scope, exceptions and trust boundaries, separate narrower lessons and useful historical evidence, verify preservation before shortening an original, and leave clear memories alone. Chronicler handles meaningful conversation increments; Anima reviews accumulated memory during its existing routine. Tool parameters and revision-conflict handling stay in the tool descriptions; the Agent prompts retain concise curation responsibilities. Anima offers that maintenance guidance only when the current entry can also be read. There is no new scheduler, maintenance agent, line quota, token limit or automatic rewrite of a user's existing records.

[Context contribution input](../../../../packages/harness/src/session/context-contributions.ts) carries the resolved Agent registration identity. [Library recall](../../../../packages/library/src/session-recall.ts) identifies the built-in Anima and Chronicler by owner and registration key, annotating their existing always entries with IDs, category, recall mode and update revision without duplicating their content. Ordinary sessions do not receive the maintenance metadata. Retrieval policy, advisory order and fallback semantics remain unchanged.

[Memory tools](../../../../packages/library/src/tools/memory.ts) expose numeric `updatedAt` and accept optional `expectedUpdatedAt`. [The database update](../../../../packages/library/src/database.ts) compares that revision in the final SQL mutation after asynchronous embedding, advances `updated_at` monotonically even within one millisecond, and commits the canonical record before maintaining the derived vector index under its existing fail-soft contract. Vector capacity or extension failures must not undo a successful canonical update. A stale revision or removed record is not rewritten. A conflict asks the agent to read and reconsider rather than drop the condition. Existing callers that omit the condition retain unconditional editing. The persisted schema is unchanged and needs no migration. The [tool-reference generator](../../../../script/gen/gen-tool-catalog.ts) resolves locally declared parameter schemas through its existing AST reader so the generated reference records the optional revision input rather than execution-result fields.

## Alternatives considered

**Remove all deferred tool names.** The current MCP group metadata is a generic server description rather than a verified capability summary. Removing names gives up discovery information and may add searches or miss capabilities. Common-prefix factoring retains that information without changing the discovery mechanism.

**Truncate always memory or lower every long entry's recall mode.** This can hide identity, consent or authorization rules mixed with historical detail. Curation separates meanings and preserves required rules rather than using a length threshold as permission to discard them.

**Add a new maintenance agent or recurring task.** Anima already has periodic reflection and Chronicler already has conversation-triggered memory work. Strengthening their responsibilities uses existing ownership and avoids duplicated scheduling and writers.

**Check the revision only before embedding.** A foreground writer can commit while embedding is in progress. The final database comparison is necessary to prevent that stale prepared result from overwriting the correction.

## Consequences

Catalog formatting reduces repeated source tokens while retaining available names, but model tool selection remains a separate acceptance question. The maintenance-specific metadata adds small overhead only to the maintainers and provides direct editing targets. Curation prompts do not prove that a model will perform successful consolidation; old Library records remain untouched until an authorized maintenance execution changes them.

Focused tests exercise retained Skill names and filtering, reconstructable MCP IDs, current availability, ordinary versus maintenance recall, real SQLite updates held behind an HTTP embedding barrier, vector preservation on conflict, deletion during preparation and same-millisecond revisions. The existing provider-loop tests verify resolved identity propagation and stable advisory/system ordering for OpenAI Codex, OpenAI and Anthropic. Test results do not establish live-provider cache-hit improvements or universal model behavior equivalence. Product semantics live in [Memory](../../../product/knowledge.md#memory) and [Tool catalog and exposure](../../../product/agents-and-tools.md#tool-catalog-and-exposure).
