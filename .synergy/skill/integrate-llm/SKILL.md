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

Text-only sessionless callers use `AgentCall.text()` without creating a durable session. The Control Plane records call intent, semantic requests, consumed stream events, and SDK usage under the owning session or a Scope operation. Provider transport attempts are captured separately at the final built-in fetch boundary, with worker chunks committed by the Control Plane before acknowledgement. Preserve explicit completeness status; semantic events alone do not prove transport capture. Title/turn summary, SmartAllow classification, agent generation, GitHub classification, and Experience encoding all use the external `AgentTurn` worker boundary. Product code must not add a direct `LLM.stream()` caller outside `session/agent-turn/runner.ts`; setup/provider bootstrap probes are the only narrow direct AI SDK exception.

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

Asynchronous derived work must carry the identity of its persisted source task, not resolve whichever task happens to be latest when the queue runs. Keep root-only prompt and model overrides out of attribution-only envelopes. Propagate `RolloutRecordingError` through optional-result fallback paths so the owning task stops and retains its failed recording state. Pass the original root ID to recording-error cancellation; a delayed auxiliary failure must not cancel a newer root in the same session.

Control Plane operations that consume non-streaming results use `RolloutCall.execute()` around the actual provider operation, preserving the same intent, transport-attempt, and terminal commit contract as streaming calls. Drain parallel owned calls before returning and preserve recording failures ahead of secondary cancellation errors.

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

`packages/cli/src/setup/config.ts` uses `generateText()` for a live provider capability probe before normal agent/session orchestration is appropriate. Keep direct AI SDK usage limited to such bootstrap/provider plumbing or the implementation of the shared `LLM` layer. Product inference should not bypass provider transforms, configured roles, plugin hooks, telemetry, timeouts, or output policy. Bootstrap probes that reach a managed-inference endpoint must pass through the same per-request header gate as normal turns (`ProviderSessionHeader.forRequest` with the resolved provider options), because the provider cannot distinguish a probe from a conversation.

## External Model Catalogs

Separate external catalog metadata from explicit user configuration. Allow additive external price fields at nested tier boundaries while retaining numeric validation and raw provenance; preserve the existing configuration acceptance rules, including strict nested rate fields. Exercise damaged individual entries, complete-catalog failure with cache preservation, cold startup, actual CLI exit/output, and the bundled runtime. Pair the pinned snapshot with focused upstream-shape fixtures, since a valid pinned snapshot cannot detect later additive fields. Follow [Service and model directory](../../../docs/reference/configuration-layout.md#service-and-model-directory) for runtime acceptance and refresh behavior.

## Provider Option Compatibility

Choosing the same AI SDK package proves only transport and wire-protocol compatibility. It does not prove provider options, thinking/reasoning controls, effort levels, tool semantics, or cache behavior are compatible with the official provider using that package.

Automatic reasoning variants are derived from model identity (`model.id`, API model ID, or model family) combined with the direct transport. They are not selected from provider IDs, and a shared npm package alone does not establish option compatibility. When adding automatic model variants or default provider options, derive them from what the real provider contract supports through the current SDK and transport. If the SDK cannot express the provider's reasoning semantics without loss, omit automatic parameters and rely on the provider default. Do not guess, clamp, translate, or apply official-provider thinking/effort semantics to a third-party service merely because it reuses that provider's wire protocol. Users can still add explicit model `variants` in config to override automatic defaults.

When a provider requires a per-request header derived from the conversation (for example OpenCode Go's `x-opencode-session`), add it through the per-call headers layer gated by the resolved endpoint (`ProviderSessionHeader`), never through provider creation options or a global header map on the SDK package. Provider-creation headers bypass the conversation boundary: language-model instances are cached across sessions, and a gate on the SDK package alone would disclose conversation ids to every service reusing that package. Resolve the endpoint the SDK will actually use (model options beat provider options; the catalog API URL is only the fallback) and scope the disclosure to that endpoint with exact host and path matching.

## Streaming Bounds

Own upload cancellation inside the recording stream so a native fetch reader lock cannot prevent settlement. Drain admitted request reads and writes before ending the attempt, including network failure and early HTTP responses; test with a cloned Request and the real recorder. Do not wait for an upstream cancellation acknowledgement shared with an unowned live sibling, or let upload cleanup failures replace the transport outcome. Request-side cleanup must not recursively wait on its own attempt finalizer.

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

For retry changes, exercise raw runtime errors, nested causes, aggregate address failures, worker serialization, SDK admission, and session recovery. Reuse `provider/retry.ts` and the shared network classifier rather than domain-name or broad message matching. Keep one owner for each retry budget; preserve cancellation, permanent failures and recording errors. A model retry must end before tool dispatch can produce effects. Test both successful transient recovery and a post-dispatch failure that must not replay the model; for derived calls, exercise both stream-start and body errors against one caller-owned budget with SDK retries disabled. Verify that retry withdrawal removes failed text and unexecuted proposals from visible history and model context while preserving rollout events, failure status, and accounting. Shared provider recovery belongs before worker admission; test cancellation, bounded waits, one recovery probe, connection isolation, and stale-success/new-failure races.

Classify by evidence strength, never by failure surface alone. The shared classifier's `transient`, `permanent`, `aborted`, and `indeterminate` kinds mean "retry may help", "deterministic failure", "cancelled", and "cause unknown but empirically transient". A mapped reason code (`CERT_HAS_EXPIRED`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `ERR_TLS_CERT_ALTNAME_INVALID`, and similar) is deterministic and stays terminal; certificate verification wording **without** a reason code is `indeterminate` and earns a narrower budget. A runtime drops the reason code exactly when it cannot attribute a verification failure, so `undefined` from the classifier means "unrecognized" and must not silently become "permanent". When adding a certificate or TLS branch, place it after the `permanent` check, keep `aborted > permanent > (indeterminate | transient)` merge precedence, and test both the unmapped wording and every mapped code.

Return the retry budget with the decision rather than relying on a global constant, so a narrower budget is explicit at the call site. Keep the classifier answering only the fact while each caller owns its budget: the session processor, `AgentCall`, and web fetch keep independent limits that must never multiply.

Never relax TLS verification to work around an endpoint failure — no `rejectUnauthorized: false`, no auto-trusting an intercepted CA. When persisting failure evidence, record the endpoint **host only**, derived from the same connection-identity source as `providerRetryKey`. Provider keys are often embedded in the URL path, so reducing a URL to its pathname is not redaction; a regression test must assert no credential path reaches persisted metadata.

1. Test the chosen lifecycle boundary as a behavior: no session for sessionless work; explicit child lineage and output for Cortex work.
2. Run focused Agent protocol/worker, provider, session, Cortex, and permission tests, then typecheck and `quality:quick`.
3. Update [LLM loop and compaction](../../../docs/architecture/llm-loop.md) when the shared call pipeline or path-selection contract changes.
4. Update `add-agent` when a new internal-agent registration pattern or model-role rule emerges.
5. Assert that `small: true` calls ignore both available and unavailable source-root variants: neither variant options nor `ProviderModelVariantUnavailableError` may reach the target-model call.

## Handoff

Report why the operation is sessionless, existing-session, Cortex, or bootstrap; the agent/model role; timeout/retry/tool/output policy; persistence and visibility; redaction; and verification.

Capture provider service-tier metadata when available; unresolved nonstandard pricing must remain unknown. Preserve live authorization evidence before side effects and inherit task snapshots during request preparation, including independent non-chat operations.

Public task cancellation must return after durable cancellation without waiting on held processors. Use explicit Cortex drainage for rollout finalization and runtime shutdown, and test both boundaries with controlled pending calls instead of timing sleeps.

Historical derived retries must not append to a terminal source rollout. Use explicit operation ownership with source identity in metadata, while preserving the caller signal; reserve causal Session ownership for work still owned by the matching root. Test this under an ambient terminal rollout so accidental context inheritance fails.

SDK usage fallback must not assign a call aggregate to each unmeasured transport retry. Test a failed attempt followed by a successful attempt with call usage, and preserve provider-specific cache inclusion and unknown cache-write counts when only SDK evidence remains.

Verify SDK output inclusion against the locked adapter: Google and Vertex expose candidate output separately from thinking, unlike OpenAI. Test reported aggregates, separate components and missing components before labeling fallback totals complete.
