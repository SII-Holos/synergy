# Decision Record: Document relay-provider config in the synergy-config skill

Status: implemented

## Problem

The `synergy-config` skill documented custom providers only at the provider level (`options` passed to the SDK constructor) and never explained model-level `options`, reasoning declarations, or streaming-reasoning requirements. Users configuring third-party relays / 中转站 hit silent failures: extra request-body args (e.g. `enable_thinking`, `chat_template_kwargs`) written into provider-level `options` are ignored, DeepSeek-style relays error when `reasoning_content` is not passed back, and reasoning-effort variants never appear because `reasoning: true` was undocumented.

## Decision

Expand the skill's provider and model references to document the provider-level vs model-level options split, the model capability fields (`reasoning`, `reasoning_options`, `interleaved`, `headers`, `variants`, `modalities`, `tool_call`, `attachment`, `temperature`), a dedicated "Third-party relays and OpenAI-compatible gateways (中转站)" section with a full two-backend example, a "Model token limits and soft compaction (context / input / output)" section explaining how `limit` fields drive the input envelope and the proactive-compaction threshold (usable input, output reservation, margin, `floor(envelope * 0.85)` soft threshold, `compaction.overflowThreshold`), and troubleshooting entries for silent extra-arg failures, `reasoning_content` replay errors, missing effort variants, and early compaction. The models reference gains a "Declaring reasoning variants for custom / relay models" subsection, and the skill decision tree routes 中转站 / relay / gateway phrasing to the provider reference. No runtime code, schema, or generated docs changed; `docs/reference/configuration-layout.md` and `docs/architecture/llm-loop.md` remain the authoritative description of budgeting and variant semantics.

## Alternatives considered

- **Extend the Settings wizard / schema to persist `reasoning_options` and object-form `interleaved`** — rejected: changes runtime behavior and UI surface; the skill documents the JSONC contract that already supports these fields, which is the immediate gap.
- **Only add troubleshooting entries** — rejected: without the field table and worked example, users cannot construct a correct relay config in the first place.

## Consequences

Users can configure 中转站 relays with working thinking/extra args, effort variants, and correctly derived compaction budgets from the skill alone. The docs now state that unknown provider-level `options` keys are silently dropped while unknown model-level keys forward to the request body — matching `@ai-sdk/openai-compatible` behavior — and that `limit.context` / `limit.input` / `limit.output` shapes the input envelope (`input` when set, else `context - output - margin` when positive, else `context`) so the soft-compaction threshold matches the API's real window. The wizard caveat is explicit: it captures a boolean `interleaved` and drops `reasoning_options`, so those must be declared in JSONC.
