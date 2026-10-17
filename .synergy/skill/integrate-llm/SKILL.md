---
name: integrate-llm
description: Add, modify, or review an LLM-backed operation in Synergy. Use for LLM.stream, AI SDK generateText/streamText, hidden internal agents, title/summary/classification/extraction calls, SmartAllow, provider probes, SessionInvoke, Cortex tasks, structured model output, or any decision about whether an LLM call should create or reuse a session.
---

# Integrate an LLM Call

For prompts, tool descriptions, injected context or model-visible results, first apply [agent-facing design](references/agent-facing-design.md).

## Choose the Execution Path First

| Required behavior                                                                                              | Path                                                           |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Derive metadata, classify, summarize, or transform without durable work history                                | Sessionless internal-agent call through the shared `LLM` layer |
| Continue work already owned by a product session                                                               | `SessionInvoke` / the existing session loop                    |
| Run bounded delegated or reviewed work with lineage, lifecycle, progress, cancellation, and an output contract | `Cortex.launch()` child session                                |
| Probe a provider before normal agent/session runtime is available                                              | Narrow direct AI SDK call in setup/probe infrastructure        |

Do not choose by convenience. If users or parent agents must inspect, resume, cancel, audit, or receive the work as a task, it belongs in a session. If the result is only derived data and a transcript would be noise, keep it sessionless.

Product inference uses the shared AgentTurn boundary. Text-only internal work uses AgentCall.text; bounded delegated work uses Cortex.launch. Keep domain prompts, parsing, fallback and persistence with their owner. Bound input/output, timeout and retries; propagate caller cancellation and recording failures. Preserve live authorization before side effects. Never relax TLS verification or put credentials in model options, prompts or evidence.

## Read the Relevant Branch

Before changing or reviewing a boundary below, read its reference and linked canonical documents. Load only the branches needed by this task.

| Boundary                                                                                        | Required reference                                             |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Internal calls, SessionInvoke, Cortex, root attribution, model preparation or structured output | [Invocation lifecycle](references/invocation-lifecycle.md)     |
| Runtime observations, memory versions, prompt/cache layout, model controls or tool catalogs     | [Runtime context](references/runtime-context.md)               |
| Embedded providers, catalogs, reasoning/options, endpoint headers or bootstrap probes           | [Provider compatibility](references/provider-compatibility.md) |
| Stream readers, transport recording, worker plans/IPC/capacity, image inputs or telemetry       | [Streaming and workers](references/streaming-workers.md)       |
| Recovery budgets, error classification, cancellation, usage/cost or derived-call ownership      | [Retries and accounting](references/retries-accounting.md)     |
| Tool schemas, workBrief, deferred-tool bindings or persisted tool input                         | [Tool intent](references/tool-intent.md)                       |

## Verify and Document

1. Test the chosen lifecycle boundary as a behavior: no session for sessionless work; explicit child lineage and output for Cortex work.
2. Run focused Agent protocol/worker, provider, session, Cortex, and permission tests, then typecheck and `quality:quick`.
3. Update [LLM loop and compaction](../../../docs/architecture/llm-loop.md) when the shared call pipeline or path-selection contract changes.
4. Update `add-agent` when a new internal-agent registration pattern or model-role rule emerges.
5. Assert that `small: true` calls ignore both available and unavailable source-root variants: neither variant options nor `ProviderModelVariantUnavailableError` may reach the target-model call.
6. Provider configuration changes, including descriptions, regenerate both shipped config schemas with `generateSchema()` from `script/release/shared/build-runtime.ts` for the core and full profiles. Run `bun test --config /dev/null test/script/release/runtime-schema.test.ts`; SDK/OpenAPI generation alone does not refresh those artifacts.

Report the execution path, agent/model role, timeout/retry/tool/output policy, persistence, visibility, redaction and verification. Provider-reported usage establishes token/cache measurements; request equality and character counts establish layout and text size only.
