# Decision Record: Stable-Prefix Local Compaction

Status: implemented

## Problem

Local compaction must summarize a native session without continuing its task or executing tools. Selecting a separate agent/model, reconstructing instructions, or dropping tool schemas changes the request prefix even when the conversation history is unchanged. Pending compaction can also occur before any provider turn, while provider context overflow requires recovery after the failed processor has released its request arrays and turn cancellation resources. These paths need one summary lifecycle without manufacturing an extra conversation call or discarding the originating execution settings.

## Decision

Native `SessionInvoke` defers pending compaction until ordinary request preparation. Explicit and automatic budget-triggered compaction call the summary owner directly, which runs `AgentTurn.prepare()` once for a cold request. A successful local attempt makes one summary call; cold manual and automatic budget paths do not send a preliminary conversation turn. Provider overflow instead summarizes the originating prepared request captured before processor cleanup, with independent request arrays and cancellation rebound to the session lease signal. Model-stream settlement releases snapshots not needed for context recovery before tools can wait for authorization or execute.

The summary reuses the original agent, model, user envelope including variant/thinking, model-selection snapshot, final system and parameter-hook results, provider preparation, ordered native tool definitions, active IDs, system cache breakpoint, late-system context, and projected materialized history. The summary instruction is a user suffix after the complete provider-specific `LLM.promptMessages()` layout, including late-user runtime context. Final preparation is reused, not reconstructed or rerun with a compaction agent.

Tool schemas remain in `tools` with `toolChoice: "none"`; no execution callbacks accompany the summary invocation. `SessionProcessor` rejects incremental tool starts and final tool calls before deferred expansion, authorization, or scheduling. A retained schema is model input, not executable authority.

Compaction budgets the complete fixed envelope plus output and tokenizer margin. It can trim oldest valid history when necessary, advancing past orphaned tool results and reserving at most 32,000 output tokens, or the configured model output limit when smaller. It verifies the retained history fits and uses mechanical recovery without a provider call if the minimum retained history is still too large. Trimming can change the history prefix; continuity never overrides context feasibility.

The compaction owner preserves `running`, `failed`, `empty`, and `committed` attempts, commit-only summary boundaries, automatic continuation, and explicit `usageRole: "compaction"`. Persisted assistant attribution still identifies the compaction operation even though native execution uses the originating agent. External-agent adapters cannot supply a native prepared prompt snapshot, so their dedicated compaction path and the registered `compaction` agent remain. Only that different-model adapter path clears root variant/thinking on its transient envelope; small sessionless calls continue to ignore those settings. Optional Codex remote compaction remains separate, default off, and does not replace the authoritative local summary.

After assistant handoff, the compaction owner settles the entire attempt and applies a fresh native operation deadline. Canonical storage finalization is checked transactionally rather than raced, avoiding late background summary commits. A summary already committed before a propagated remote evidence error or operation timeout stays authoritative without automatic continuation; best-effort remote provider failures still permit continuation. Storage blocking can delay return, and non-cooperative processor terminal writes require restoration after settlement; eliminating that transient window would require conditional writes in the processor/storage owner.

The canonical implementation invariants live in [LLM loop and compaction](../../../architecture/llm-loop.md#compaction); maintenance and verification procedures live in [Integrate an LLM Call](../../../../.synergy/skill/integrate-llm/references/runtime-context.md#preserve-native-local-compaction).

Provenance: OpenAI Prompt Caching guide, `https://platform.openai.com/docs/guides/prompt-caching`.

Local adaptation: Preserve the originating native request's instructions, model settings, tool definitions and history, then append summary instructions, following the guide's constraint that reuse depends on matching rendered prefixes and relevant settings. This is intended reuse eligibility only: provider rendering, cache availability, routing, and context trimming can prevent hits. The decision makes no cache-hit, latency, token-cost, or performance-savings claim.

## Alternatives considered

**Use a dedicated compaction model for every session.** This allows independent summary-model configuration but changes model, instructions and options instead of preserving the originating native request. It remains the necessary path for external adapters that cannot expose that request, not the native default.

**Reconstruct a matching prompt from durable history and configuration.** Reconstruction cannot reliably reproduce final hooks, materialized attachments, the selected model settings, provider preparation, and ordered active schemas from the originating turn. Passing the prepared request keeps one owner for those values and avoids rerunning mutable preparation during overflow recovery.

**Remove tool schemas to enforce summary-only behavior.** Dropping schemas changes the model input prefix. Keeping them with explicit provider tool disablement and an early processor rejection preserves input continuity without passing executable callbacks or relying on configurable agent permissions.

**Blindly resend an overflowing request with a summary suffix.** The suffix and summary output require additional room. Measuring the full fixed envelope and trimming oldest valid history is necessary even though trimming reduces prefix continuity. A context-length failure during summarization still uses the deterministic mechanical fallback; other failures remain explicit.

## Consequences

The Agent worker handshake uses protocol version 17 for the combined prepared-request suffix and worker-memory fields, so older workers reject the incompatible request before dispatch. Integration retains pressure-driven pruning, versioned runtime context and provider failure evidence.

Native summary input has a single preparation owner and retains the originating request where the context budget permits. Tool disablement is enforced locally even if a provider emits tool events despite `toolChoice: "none"`. Cold compaction avoids a separate conversation generation, and overflow recovery survives processor cleanup without inheriting a disposed turn signal.

Native summaries use the selected conversation model and its settings rather than an independently chosen compaction model, which gives up that independent model selection. Preserved schemas and system context consume summary input budget, potentially requiring history trimming. A different provider rendering or relevant setting can still break cache eligibility; actual reuse and economics require independent provider evidence. External adapter and optional remote paths remain distinct rather than pretending to share an unavailable native snapshot.
