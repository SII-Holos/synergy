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

Text-only sessionless callers use `AgentCall.text()` without creating a durable session or persisting the inference exchange. Title/turn summary, SmartAllow classification, agent generation, GitHub classification, and Experience encoding all use the external `AgentTurn` worker boundary. Product code must not add a direct `LLM.stream()` caller outside `session/agent-turn/runner.ts`; setup/provider bootstrap probes are the only narrow direct AI SDK exception.

For every sessionless call:

1. Define or reuse a hidden internal agent with the correct model role, prompt, temperature, and no unnecessary tools.
2. Call `AgentCall.text()` with the Agent name, messages, explicit retry/timeout/input/output bounds, caller signal, and only a domain-owned fallback model when required. It owns Agent/model resolution, an empty serializable tool catalog, bounded collection, combined cancellation, Agent worker admission, and stream disposal.
3. Keep prompt construction, fallback choice, retry count, structured parsing, persistence, and error mapping in the owning domain.
4. Do not access AI SDK stream/text getters directly because each getter retains a tee branch until explicitly cancelled.
5. Use a Session or Cortex instead when tools, durable history, resumability, progress, or completion delivery are part of the contract.
6. Bound input and output, treat tagged/untrusted content as data, and redact secrets before policy/classification calls.
7. Parse and validate structured output with Zod or an equivalent explicit schema. Define whether timeout, unavailable model, malformed output, or provider error fails soft or propagates.
8. Test model-role fallback, timeout/cancellation, stream disposal, parsing, redaction, and failure semantics without making a live provider call.
9. Treat any `MessageV2.User.variant` on a reused source or root envelope as durable root-execution metadata. A `small: true` sessionless call must neither validate nor apply it; the call uses `ProviderTransform.smallOptions()` for its target model.

A sessionless call does not create session history, Cortex progress, completion notices, or Experience lineage. Do not imply those properties in UI or events.

## Session and Cortex Calls

Use `SessionInvoke` when the caller already owns the target session: direct user/API input, Channel or Agenda execution, workflow continuation, or an in-place loop operation such as compaction.

When an in-place internal operation reuses a root user message only for task identity or attribution while selecting a different model, strip root-owned execution settings that do not belong to the target call. Compaction specifically keeps the persisted root unchanged but clears its `variant` from the ephemeral processor envelope, so the compaction model retains normal provider options without validating or applying another model's variant.

Use `Cortex.launch()` for new child-agent work. Cortex owns:

- child session creation and parent lineage
- agent/model resolution and control-profile inheritance
- concurrency, progress, cancellation, timeouts, and cleanup
- summary, final-response, or structured output contracts
- parent delivery and DAG binding

Do not manually combine `Session.create()` and `SessionInvoke.invoke()` for ordinary delegation. Existing specialized flows such as `look_at` and Chronicler predate or bypass parts of the Cortex contract; treat them as cases to justify or converge when touched, not templates for new child work.

Use Cortex for decisions that must be independently auditable. Choose task visibility from the product contract: make reviewers visible when users should inspect their progress through ordinary task surfaces, and use hidden visibility only when the review is strictly internal implementation work. Do not replace a reviewer task with a sessionless classifier merely because both call a model.

## Direct AI SDK Calls

`config/setup.ts` uses `generateText()` for a live provider capability probe before normal agent/session orchestration is appropriate. Keep direct AI SDK usage limited to such bootstrap/provider plumbing or the implementation of the shared `LLM` layer. Product inference should not bypass provider transforms, configured roles, plugin hooks, telemetry, timeouts, or output policy. Bootstrap probes that reach a managed-inference endpoint must pass through the same per-request header gate as normal turns (`ProviderSessionHeader.forRequest` with the resolved provider options), because the provider cannot distinguish a probe from a conversation.

## Provider Option Compatibility

Choosing the same AI SDK package proves only transport and wire-protocol compatibility. It does not prove provider options, thinking/reasoning controls, effort levels, tool semantics, or cache behavior are compatible with the official provider using that package.

Automatic reasoning variants are derived from model identity (`model.id`, API model ID, or model family) combined with the direct transport. They are not selected from provider IDs, and a shared npm package alone does not establish option compatibility. When adding automatic model variants or default provider options, derive them from what the real provider contract supports through the current SDK and transport. If the SDK cannot express the provider's reasoning semantics without loss, omit automatic parameters and rely on the provider default. Do not guess, clamp, translate, or apply official-provider thinking/effort semantics to a third-party service merely because it reuses that provider's wire protocol. Users can still add explicit model `variants` in config to override automatic defaults.

When a provider requires a per-request header derived from the conversation (for example OpenCode Go's `x-opencode-session`), add it through the per-call headers layer gated by the resolved endpoint (`ProviderSessionHeader`), never through provider creation options or a global header map on the SDK package. Provider-creation headers bypass the conversation boundary: language-model instances are cached across sessions, and a gate on the SDK package alone would disclose conversation ids to every service reusing that package. Resolve the endpoint the SDK will actually use (model options beat provider options; the catalog API URL is only the fallback) and scope the disclosure to that endpoint with exact host and path matching.

## Streaming Bounds

Production product inference enters `AgentTurn`: the Control Plane resolves final prompt and parameter plugin hooks plus serializable provider options into a request plan, request snapshots are schema-validated and capped, and the plan is sent as acknowledged chunks; event frames are bounded and acknowledged after consumption. The worker protocol owns its event projection: do not expose raw AI SDK stream objects as IPC types, and strip provider request bodies, response diagnostics, warnings, or other fields the Control Plane does not consume before checking the frame bound. Agent workers reconstruct built-in provider runtime functions without provider-plugin discovery. Keep executable callbacks, plugin runtimes and Host Services, session writers, permission promises, and other Control Plane handles out of the worker input. Model-facing tools are `ToolCatalog.Definition[]` only.

Keep optional prompt diagnostics and Context Usage attribution out of the Agent worker request and provider-start critical path. Start the provider turn first, execute any non-trivial estimation in a separately isolated worker with fixed input, concurrency, and wall-time bounds, and fail open by omitting the enrichment. Do not move synchronous tokenization onto the Control Plane event loop or await optional enrichment before provider streaming or loop completion.

When changing Agent worker capacity, a higher ceiling must admit queued demand immediately without eagerly filling unused capacity. Shrink by releasing idle workers first and retiring excess active workers only after their owned turns terminate. A capacity change must never abort an active turn merely to reach the new target. Test higher-ceiling demand plus idle and fully active shrink paths.

Coalesce adjacent streamed tool-input deltas by call ID before IPC, cap each coalesced delta, and preserve cross-call event order. Do not forward one IPC frame per provider token fragment: streamed tool arguments are progress data, while the final AI SDK `tool-call` input remains canonical. Treat one active-turn Bun `heapUsed` heartbeat as a pressure signal rather than proof of retained memory; request a full collection in that worker and require the corresponding post-collection sample to remain over the watermark before terminating the turn.

The executable bootstrap and Agent worker runner static value-import graphs are also product boundaries. Keep `src/index.ts` free of static application imports so compiled worker subcommands do not evaluate the main CLI/server graph. The Agent runner value-import graph may include only worker-safe, side-effect-free schemas and helpers (import `ModelsDev` from `provider/models-schemas.ts`, not `provider/models.ts`). Exclude `provider/models.ts` (runtime/cache/macro dependent), `provider/models-macro.ts` (compile-time external network I/O), Browser, Tool, Plugin, Plugin Runtime, `packages/browser`, and provider SDK implementations from the runner graph. ModelsDev runtime, catalog, and macro remain Control Plane / host-only; no compile-time or module-load external network or other unbounded I/O may execute before the worker `ready`/heartbeat. Resolve Control Plane preparation dependencies before transfer, and load only the selected built-in provider SDK lazily inside the worker. Update and run `test/session/agent-worker-runtime-boundary.test.ts` when this boundary changes.

Provider SSE protection is a per-event parser bound, not a total response, transport chunk, or process-memory limit. Keep code identifiers, error names, tests, and architecture documentation explicit about `SSE event parser bound` semantics. Test LF and CRLF event delimiters across chunk boundaries, including consecutive events exactly at the bound.

Any provider stream wrapper that calls `getReader()` owns that reader lock. Keep reads pull-based, cancel the reader when the wrapper fails or is cancelled, and release the lock after normal completion, failure, timeout, and downstream cancellation. Test the lifecycle against a real `ReadableStream` by asserting that the upstream stream is unlocked after every terminal path.

Tool-call input has a separate serialized-input bound. Enforce it for incremental argument deltas, final-only provider tool calls, and immediately before executor dispatch so providers cannot bypass it by omitting delta events.

Treat streamed tool argument deltas as transport/progress data, not canonical tool input. Use them for incremental byte limits, memory accounting, and diagnostics. Once the AI SDK emits `tool-call`, use its final `input` consistently for the final serialized-input bound, persisted tool part, loop guards, permission evaluation, and execution. Test providers that omit deltas and cases where streamed raw arguments differ from the final AI SDK input.

## Verify and Document

1. Test the chosen lifecycle boundary as a behavior: no session for sessionless work; explicit child lineage and output for Cortex work.
2. Run focused Agent protocol/worker, provider, session, Cortex, and permission tests, then typecheck and `quality:quick`.
3. Update [LLM loop and compaction](../../../docs/architecture/llm-loop.md) when the shared call pipeline or path-selection contract changes.
4. Update `add-agent` when a new internal-agent registration pattern or model-role rule emerges.
5. Assert that `small: true` calls ignore both available and unavailable source-root variants: neither variant options nor `ProviderModelVariantUnavailableError` may reach the target-model call.

## Handoff

Report why the operation is sessionless, existing-session, Cortex, or bootstrap; the agent/model role; timeout/retry/tool/output policy; persistence and visibility; redaction; and verification.
