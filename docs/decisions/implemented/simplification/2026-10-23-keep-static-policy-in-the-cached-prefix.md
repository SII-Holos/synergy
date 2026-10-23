# Decision Record: Keep static behaviour policy in the cached prompt prefix

Status: implemented

## Problem

Behaviour policy that never changes between turns was carried in the volatile advisory tail. `SessionInvoke` rebuilt that tail on every model round, and its first two entries were compile-time constants: the `workBrief` guidance and the attachment presentation guidance. Both were therefore re-sent and re-billed each round, and both sat outside the cache breakpoint.

The position was worse than the cost. For the layouts that append the tail as a final user message — `openai`, `openai-codex`, `deepseek`, `anthropic` and every `@ai-sdk/openai-compatible` transport — those constants became the last user message before generation. General behaviour rules ended up at the highest-weight position of the request, where a model weighs them above the system instructions that came earlier.

The same block also carried a clause its owning decision record never authorized. [Tool intent and qualified execution evidence](../architecture/2026-10-01-tool-intent-and-execution-evidence.md) approved "a single purpose-and-target instruction"; the shipped text appended "Report outcomes after receiving the tool result". That clause had no consumer, no test, and directly opposed the shared progress policy's "Do not narrate routine tool calls or steps". It invited the per-tool narration that policy exists to prevent.

## Decision

`ToolIntent.guidance` and `AttachmentDelivery.guidance().response` join the cached system prefix in `SessionInvoke`, ahead of discovered instruction files. They are sent once as part of the stable prefix instead of once per round, and they no longer form part of the final user message on late-user-context layouts. The advisory tail now carries only what genuinely varies per round: host identity, environment facts, git health, the coauthor reminder, secret-token semantics, recall, Cortex status and elapsed time. Host identity therefore becomes the first advisory source.

`ToolIntent.guidance` states intent only. The `workBrief` field description is unchanged and the tool card still renders it, so the intent the guidance asks for remains visible to the user.

The coauthor reminder and secret-token semantics stay in the advisory tail. They derive from live state (`Config.current()` and `SecretVault.hasAny()`), so they can legitimately appear or disappear mid-session, and the advisory mechanism is what documents their provenance states.

## Alternatives considered

**Keep the tail and rely on the model to prefer system over user instructions.** The whole complaint is that a nearer, more specific user-role instruction outweighed earlier system policy. Position and role are what a model actually weighs, and no unit test can assert compliance, so this leaves the dominant position occupied by general rules.

**Keep the outcome-reporting clause for surfaces without a tool card.** No consumer reads it: nothing in the runtime, the transcript or the UI resolves it, and the intent it duplicates is already rendered from `workBrief`. Keeping it preserves an instruction whose only observable effect is extra assistant prose.

**Give each model its own copy of the guidance.** This is a parallel stack. Thirty-five agent prompt files would start diverging, and no test can establish which copy a given model should receive, so the tuning would be unfalsifiable.

**Move the coauthor reminder and secret-token semantics as well.** They change with live configuration rather than being frozen at composition, so they belong to the layer whose states the runtime-context protocol describes.

## Consequences

Static policy is now cached and the tail shrinks by roughly 1,500 characters per round. On layouts that append the tail as a final user message, generation no longer starts from a block of general behaviour rules.

Existing assertions had to change with the layout: the durable observation now begins with `synergy-runtime` instead of replaying the two policy blocks as advisory sources, and the test asserts their absence from every observation rather than their position in one. Three documents that described the old fixed slot were updated in the same change.

Costs. Policy in the cached prefix can no longer be tuned per round; adapting it at runtime now invalidates the cached prefix instead of editing the tail. Providers without prefix caching gain nothing in bytes, only a different ordering. Nothing asserts that a model behaves better for the move: the change is justified by removing an uncontracted instruction and by not resending constants, both of which are checkable, while the verbosity improvement itself rests on the position argument above and remains unmeasured in this repository.
