# Sessionless, Session and Cortex invocation

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
   `AgentCall` returns native output-tool arguments after decoding the common intent facade. Do not add presentation fields to business schemas or strip arbitrary unknown fields to accept them. Test both flat inputs and an enveloped native schema with a field named `workBrief`.
8. Test model-role fallback, timeout/cancellation, stream disposal, parsing, redaction, and failure semantics without making a live provider call.
9. Treat any `MessageV2.User.variant` on a reused source or root envelope as durable root-execution metadata. A `small: true` sessionless call must neither validate nor apply it; the call uses `ProviderTransform.smallOptions()` for its target model.

Asynchronous derived work must carry the identity of its persisted source task, not resolve whichever task happens to be latest when the queue runs. Keep root-only prompt and model overrides out of attribution-only envelopes. Propagate `RolloutRecordingError` through optional-result fallback paths so the owning task stops and retains its failed recording state. Pass the original root ID to recording-error cancellation; a delayed auxiliary failure must not cancel a newer root in the same session.

Control Plane operations that consume non-streaming results use `RolloutCall.execute()` around the actual provider operation, preserving the same intent, transport-attempt, and terminal commit contract as streaming calls. Drain parallel owned calls before returning and preserve recording failures ahead of secondary cancellation errors.

A sessionless call does not create session history, Cortex progress, completion notices, or Experience lineage. Do not imply those properties in UI or events.

For optional model-backed prompt preparation, choose a domain-owned interactive deadline through the context contribution contract. Share prerequisite results across parallel consumers, propagate cancellation, and do not retry the same failed prerequisite independently in each branch. Verify that timeout preserves required non-model context and does not change explicit tool execution budgets.

## Session and Cortex Calls

When an embedded domain must freeze editable state before generation, register `SessionExecutionContributions.prepareModel` during composition. Use the persisted assistant/root identities to authorize and store that observation. Keep callback work bounded and cancellable; propagate storage or authorization failure. Test independent instances, cancellation, failed preparation without model dispatch, and a stale edit after a successful observation. Advisory context and executor-time refresh cannot replace that observation.

Use `SessionInvoke` when the caller already owns the target session: direct user/API input, Channel or Agenda execution, workflow continuation, or an in-place loop operation such as compaction.

When an internal operation selects a different model and reuses a root envelope only for attribution, strip root-owned execution settings from that transient envelope, not the persisted root. The external-agent adapter’s dedicated compaction path clears both `variant` and `thinking`; `small: true` sessionless calls ignore them. Native local compaction preserves the original agent/model/user settings and prepared request. Keep small-call bypass tests for valid and invalid source selections.

Use `Cortex.launch()` for new child-agent work. Cortex owns:

- child session creation and parent lineage
- agent/model resolution and control-profile inheritance
- concurrency, progress, cancellation, timeouts, and cleanup
- summary, final-response, or structured output contracts
- parent delivery and DAG binding

Do not manually combine `Session.create()` and `SessionInvoke.invoke()` for ordinary delegation. Existing specialized flows such as `look_at` and Chronicler predate or bypass parts of the Cortex contract; treat them as cases to justify or converge when touched, not templates for new child work.

Use Cortex for decisions that must be independently auditable. Choose task visibility from the product contract: make reviewers visible when users should inspect their progress through ordinary task surfaces, and use hidden visibility only when the review is strictly internal implementation work. Do not replace a reviewer task with a sessionless classifier merely because both call a model.
