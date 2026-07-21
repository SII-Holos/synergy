---
name: integrate-llm
description: Add, modify, or review an LLM-backed operation in Synergy. Use for LLM.stream, AI SDK generateText/streamText, hidden internal agents, title/summary/classification/extraction calls, SmartAllow, provider probes, SessionInvoke, Cortex tasks, structured model output, or any decision about whether an LLM call should create or reuse a session.
---

# Integrate an LLM Call

## Choose the Execution Path First

| Required behavior                                                                                              | Path                                                           |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Derive metadata, classify, summarize, or transform without durable work history                                | Sessionless internal-agent call through the shared `LLM` layer |
| Continue work already owned by a product session                                                               | `SessionInvoke` / the existing session loop                    |
| Run bounded delegated or reviewed work with lineage, lifecycle, progress, cancellation, and an output contract | `Cortex.launch()` child session                                |
| Probe a provider before normal agent/session runtime is available                                              | Narrow direct AI SDK call in setup/probe infrastructure        |

Do not choose by convenience. If users or parent agents must inspect, resume, cancel, audit, or receive the work as a task, it belongs in a session. If the result is only derived data and a transcript would be noise, keep it sessionless.

## Sessionless Internal-Agent Calls

Current sessionless callers resolve a hidden agent and model, then call `LLM.stream()` without creating a durable session or persisting the inference exchange. They may pass an existing or request-scoped session/message identity because the shared API requires context. Examples include title/turn summary, Experience intent/script/reward encoding, SmartAllow classification, and agent generation.

The `callAgent()` in `library/experience-encoder.ts` is currently private to that module; it is not a repository-wide API. Do not copy another local wrapper. When adding a new sessionless caller, reuse or extract a shared internal-agent-call helper and migrate adjacent boilerplate when the scope permits. Until that helper exists, follow the established `LLM.stream()` boundary rather than calling the AI SDK directly.

For every sessionless call:

1. Define or reuse a hidden internal agent with the correct model role, prompt, temperature, and no unnecessary tools.
2. Resolve it through `Agent.get()`, `Agent.getAvailableModel()`, and `Provider.getModel()` so role configuration and availability remain authoritative.
3. Use `LLM.stream()` so provider transforms, variants, prompt-cache policy, plugin chat hooks, telemetry, and reasoning normalization still apply.
4. Consume the result through `LLM.collectText()`, `LLM.takeTextStream()`, or `LLM.takeFullStream()`. Dispose owned streams in `finally`; do not access AI SDK stream/text getters directly because each getter retains a tee branch until explicitly cancelled.
5. Supply a bounded abort timeout, explicit retry count, and `tools: {}` unless tool execution is intentionally part of the contract.
6. Bound input and output, treat tagged/untrusted content as data, and redact secrets before policy/classification calls.
7. Parse and validate structured output with Zod or an equivalent explicit schema. Define whether timeout, unavailable model, malformed output, or provider error fails soft or propagates.
8. Test model-role fallback, timeout/cancellation, stream disposal, parsing, redaction, and failure semantics without making a live provider call.

A sessionless call does not create session history, Cortex progress, completion notices, or Experience lineage. Do not imply those properties in UI or events.

## Session and Cortex Calls

Use `SessionInvoke` when the caller already owns the target session: direct user/API input, Channel or Agenda execution, workflow continuation, or an in-place loop operation such as compaction.

Use `Cortex.launch()` for new child-agent work. Cortex owns:

- child session creation and parent lineage
- agent/model resolution and control-profile inheritance
- concurrency, progress, cancellation, timeouts, and cleanup
- summary, final-response, or structured output contracts
- parent delivery and DAG binding

Do not manually combine `Session.create()` and `SessionInvoke.invoke()` for ordinary delegation. Existing specialized flows such as `look_at` and Chronicler predate or bypass parts of the Cortex contract; treat them as cases to justify or converge when touched, not templates for new child work.

Use Cortex for decisions that must be independently auditable. Choose task visibility from the product contract: make reviewers visible when users should inspect their progress through ordinary task surfaces, and use hidden visibility only when the review is strictly internal implementation work. Do not replace a reviewer task with a sessionless classifier merely because both call a model.

## Direct AI SDK Calls

`config/setup.ts` uses `generateText()` for a live provider capability probe before normal agent/session orchestration is appropriate. Keep direct AI SDK usage limited to such bootstrap/provider plumbing or the implementation of the shared `LLM` layer. Product inference should not bypass provider transforms, configured roles, plugin hooks, telemetry, timeouts, or output policy.

## Provider Option Compatibility

Choosing the same AI SDK package proves only transport and wire-protocol compatibility. It does not prove provider options, thinking/reasoning controls, effort levels, tool semantics, or cache behavior are compatible with the official provider using that package.

Automatic reasoning variants are derived from model identity (`model.id`, API model ID, or model family) combined with the direct transport. They are not selected from provider IDs, and a shared npm package alone does not establish option compatibility. When adding automatic model variants or default provider options, derive them from what the real provider contract supports through the current SDK and transport. If the SDK cannot express the provider's reasoning semantics without loss, omit automatic parameters and rely on the provider default. Do not guess, clamp, translate, or apply official-provider thinking/effort semantics to a third-party service merely because it reuses that provider's wire protocol. Users can still add explicit model `variants` in config to override automatic defaults.

## Streaming Bounds

Provider SSE protection is a per-event parser bound, not a total response, transport chunk, or process-memory limit. Keep code identifiers, error names, tests, and architecture documentation explicit about `SSE event parser bound` semantics. Test LF and CRLF event delimiters across chunk boundaries, including consecutive events exactly at the bound.

Tool-call input has a separate serialized-input bound. Enforce it for incremental argument deltas, final-only provider tool calls, and immediately before executor dispatch so providers cannot bypass it by omitting delta events.

## Verify and Document

1. Test the chosen lifecycle boundary as a behavior: no session for sessionless work; explicit child lineage and output for Cortex work.
2. Run focused agent/provider/session/Cortex/permission tests, then typecheck and `quality:quick`.
3. Update [LLM loop and compaction](../../../docs/architecture/llm-loop.md) when the shared call pipeline or path-selection contract changes.
4. Update `add-agent` when a new internal-agent registration pattern or model-role rule emerges.

## Handoff

Report why the operation is sessionless, existing-session, Cortex, or bootstrap; the agent/model role; timeout/retry/tool/output policy; persistence and visibility; redaction; and verification.
