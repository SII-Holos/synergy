# Unified Session Compaction Design

## Status

Historical design note. The main prompt-budget refactor described here has now been implemented, primarily in `packages/synergy/src/session/prompt-budgeter.ts` and `packages/synergy/src/session/invoke.ts`.

This document remains useful as rationale, but it no longer describes a purely hypothetical design.

## Problem

Synergy's current session compaction behavior has accumulated multiple overlapping mechanisms:

- preemptive overflow detection in `packages/synergy/src/session/loop-signals.ts`
- two different overflow heuristics (`Check 1` and `Check 2`)
- provider usage-based calibration logic
- emergency compaction fallback in `packages/synergy/src/session/invoke.ts`
- summary-based history hiding in `packages/synergy/src/session/message-v2.ts`
- provider-specific cache fields such as Anthropic `cache.read` and `cache.write`

This makes the system hard to reason about and produces poor behavior for some models, especially Anthropic-backed sessions. In real sessions, compaction may trigger repeatedly because the system mixes together:

- model limit normalization
- runtime prompt-size estimation
- provider-reported usage metrics
- prompt caching metadata
- continuation flow after compaction

The result is a control loop that is difficult to predict and difficult to tune.

## Goal

Replace the current multi-heuristic compaction mechanism with a single model:

1. normalize provider limits into one input budget
2. measure the actual prompt that will be sent to the main model
3. trigger compaction when that measured prompt crosses a single threshold
4. compact through one primary path
5. keep one fallback path for provider-side misses

The target behavior is simple:

> when the next main-model request would exceed the configured safe input budget, compact first; otherwise do not compact.

## Non-Goals

This proposal does not attempt to:

- redesign the entire memory/engram system
- solve all prompt-quality issues in compaction summaries
- unify every provider's tokenizer exactly
- remove all provider-specific usage fields from telemetry or pricing

Those remain separate concerns.

## Design Principles

### One budget

There must be one authoritative answer to:

> how many input tokens may this request safely consume?

### One measurement

There must be one authoritative answer to:

> how large is the prompt that we are about to send?

### One trigger

There must be one authoritative rule for:

> should we compact before sending this request?

### Separate control from telemetry

Compaction control should not depend on post-hoc provider usage fields when a direct prompt-size estimate is available.

### Provider-neutral core

The core algorithm should work for:

- models with `context + output`
- models with `context + input + output`
- providers with prompt caching fields
- providers without prompt caching fields

### Stable fallback

Provider-side context-exceeded errors should remain recoverable, but only as a fallback when preflight budgeting misses.

## Current Failure Modes

### 1. Multiple trigger models

Today, compaction can be triggered by:

- last-assistant token usage
- conversation estimation plus overhead calibration
- emergency provider error recovery

These paths are conceptually different and can disagree.

### 2. Provider usage mixed with context occupancy

Current logic partly relies on provider usage fields such as:

- `input`
- `cache.read`
- `cache.write`
- `reasoning`

These are useful for billing and diagnostics, but not stable enough to serve as the primary compaction trigger across providers.

### 3. Anthropic cache phase distortion

Anthropic sessions commonly exhibit:

- large `cache.read` after stable history reuse
- large `cache.write` after summary replacement or prompt-shape changes

This means provider usage can swing heavily even when the user-visible history changes only modestly.

### 4. Prompt-size estimate is indirect

Current logic estimates visible conversation size, then tries to recover hidden overhead by calibrating against the previous turn's usage. This is inherently indirect. The system should instead estimate the final prompt directly.

### 5. Compaction continuation is coupled to transcript flow

Auto-compaction currently creates a synthetic user continuation message (`"Continue if you have next steps"`). That behavior may be useful, but it should not be confused with the compaction trigger itself.

## Unified Model

The unified model has five steps.

### Step 1: Normalize provider limits

Introduce a normalized limit shape:

```ts
type NormalizedLimits = {
  contextWindow: number
  maxInputTokens?: number
  maxOutputTokens?: number
}
```

This is derived from `Provider.Model.limit`.

Rules:

- `contextWindow` comes from `limit.context`
- `maxInputTokens` comes from `limit.input` when present
- `maxOutputTokens` comes from `limit.output` when present

This keeps provider differences explicit without leaking them into compaction logic.

### Step 2: Compute one hard input budget

We need the maximum safe input size for the next main-model request.

Definitions:

```ts
reservedOutput = min(maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE, runtimeOutputCap)

hardInputBudget = min(maxInputTokens ?? Infinity, contextWindow - reservedOutput)
```

Interpretation:

- if the provider gives a separate input cap, respect it
- if the provider only gives a shared context window, reserve output space and use the remainder
- if both are present, the stricter value wins

Examples:

### GPT-5.4

If a model exposes:

- `contextWindow = 400000`
- `maxInputTokens = 272000`
- `maxOutputTokens = 128000`
- `runtimeOutputCap = 32000`

then:

```ts
reservedOutput = 32000
hardInputBudget = min(272000, 400000 - 32000) = 272000
```

### Anthropic 200k-class model

If a model exposes:

- `contextWindow = 200000`
- `maxInputTokens = undefined`
- `maxOutputTokens = 128000` or provider max
- `runtimeOutputCap = 32000`

then:

```ts
reservedOutput = 32000
hardInputBudget = 200000 - 32000 = 168000
```

### Step 3: Compute one soft compaction threshold

Compaction should happen before the hard budget is exhausted.

```ts
safetyMargin = max(8000, min(32000, floor(hardInputBudget * 0.08)))
softCompactBudget = hardInputBudget - safetyMargin
```

Rationale:

- small models still need a floor
- large models should not lose excessive budget to a fixed giant buffer
- a proportional margin is more stable than a hardcoded ratio without floor/cap

The exact constants can remain configurable, but the shape should stay simple.

### Step 4: Measure the actual next prompt

This is the most important change.

Compaction must be based on the size of the prompt that is actually about to be sent to the main model.

That prompt includes:

- environment/system prompt parts
- custom system prompt parts
- cortex execution context
- cortex reminder
- memory/engram injection
- resolved tool schemas
- the visible session messages after compaction filtering and any transforms
- any synthetic runtime reminders added before inference
- any model-specific wrappers that Synergy itself adds before calling the provider

This yields:

```ts
assembledPromptTokens = estimateMainPrompt({
  model,
  systemParts,
  toolSchemas,
  messages,
  attachments,
})
```

This estimate should be taken as late as possible, immediately before the main provider call, so it reflects the real prompt shape.

### Step 5: Trigger compaction with one rule

```ts
shouldCompact = assembledPromptTokens >= softCompactBudget
```

That is the primary compaction trigger.

No separate `Check 1` and `Check 2` should remain in the steady-state path.

## What Counts for Compaction vs Telemetry

This proposal separates two concepts that are currently entangled.

### Prompt occupancy metrics

Used for compaction control.

Source:

- direct estimate of the assembled next prompt

This should not be derived from previous-turn usage.

### Provider usage metrics

Used for pricing, diagnostics, and observability.

Source:

- provider response usage fields

Examples:

- `input`
- `output`
- `reasoning`
- `cache.read`
- `cache.write`

These remain important, but they are not the primary trigger signal.

## Cache Semantics

### Cache fields remain telemetry

For Anthropic-style providers, `cache.read` and `cache.write` should remain first-class usage fields in:

- cost accounting
- logs
- session diagnostics
- debugging tools

### Cache fields should not drive compaction directly

Compaction should not trigger because `cache.read` or `cache.write` happened to be large in the previous provider response. Instead, if those fields matter, they must matter indirectly through the actual assembled prompt size.

This is the cleanest way to avoid provider-specific cache-phase distortions.

## Summary Representation

Today, compaction writes an assistant summary message and hides earlier history via `filterCompacted()`.

That mechanism can stay temporarily, but the longer-term target should be more explicit:

- a `session brief` or `compacted context` artifact
- treated as a distinct state object, not just another normal assistant turn

Recommended long-term visible prompt layout:

1. system and runtime context
2. stable project/session brief
3. recent live turns
4. active working-set context

This is more stable than repeatedly nesting summaries inside the regular transcript.

## Compaction Pipeline

The unified compaction pipeline should be two-stage.

### Stage A: Deterministic pruning

Before asking an LLM to summarize, first remove low-value transcript mass while preserving valid structure.

Examples:

- clear old tool outputs that are already pruned-safe
- drop structural-only parts like `step-start`
- collapse stale synthetic reminders
- preserve valid user/assistant/tool-result groupings
- preserve recent active turns

This is cheap, predictable, and should happen every time.

### Stage B: Session-brief summarization

If deterministic pruning is insufficient, fold older history into a compact summary artifact.

Requirements:

- summary must retain task continuity
- summary must retain active files, decisions, open loops, pending user asks
- summary must fit into a bounded token target
- summary must replace older history, not merely coexist with a nearly unchanged transcript mass

## Fallback Model

There should be exactly one fallback path.

### Preflight path

Normal operation:

1. build the final prompt plan
2. estimate `assembledPromptTokens`
3. compact if above threshold
4. send request

### Emergency path

If the provider still returns a context-exceeded error:

1. run one more aggressive compaction pass
2. retry once
3. if it still fails, stop and explain

This keeps emergency logic as a recovery mechanism, not a parallel control loop.

## Proposed Refactor

### New abstraction: PromptBudgeter

Introduce a dedicated component responsible for:

- normalizing limits
- computing hard and soft budgets
- estimating assembled prompt size
- returning a single compaction decision

Suggested shape:

```ts
type PromptBudget = {
  hardInputBudget: number
  softCompactBudget: number
  reservedOutput: number
  safetyMargin: number
}

type PromptMeasure = {
  assembledPromptTokens: number
  modelID: string
}

type CompactionDecision = {
  shouldCompact: boolean
  reason?: "soft-budget-exceeded"
  budget: PromptBudget
  measure: PromptMeasure
}
```

Suggested API:

```ts
PromptBudgeter.plan({ model, runtimeOutputCap, safetyConfig })
PromptBudgeter.measure({ model, promptParts })
PromptBudgeter.decide({ model, promptParts, runtimeOutputCap, safetyConfig })
```

This removes budgeting logic from `loop-signals.ts` and makes compaction decisions inspectable and testable.

### New abstraction: SessionBrief

Longer-term, introduce an explicit compacted-state representation:

```ts
type SessionBrief = {
  summary: string
  activeFiles: string[]
  openLoops: string[]
  recentUserIntent: string[]
  generatedAt: number
  sourceBoundaryMessageID: string
}
```

This can initially still be stored as a summary assistant message for compatibility, but the interface should move toward explicit state.

## Migration Plan

### Phase 1: Introduce unified budgeting without behavior expansion

- add `PromptBudgeter`
- compute normalized limits in one place
- estimate final prompt size near provider call site
- keep existing compaction summary storage model
- keep emergency fallback

### Phase 2: Replace multi-heuristic trigger logic

- remove steady-state `Check 1` and `Check 2`
- replace with one `PromptBudgeter.decide(...)`
- keep one diagnostic log record showing budget and measured prompt size

### Phase 3: Separate telemetry from control

- preserve current usage accounting for billing and stats
- stop using provider usage to drive normal compaction decisions
- keep provider usage only for logs, UI, and debugging

### Phase 4: Rework continuation behavior

Re-evaluate automatic synthetic continuation after compaction.

Options:

- keep it, but make it an explicit policy
- disable it for some provider/model classes
- replace it with in-loop continuation without synthetic transcript messages

This decision should be made after Phase 2, once compaction triggering is already unified.

### Phase 5: Introduce explicit SessionBrief state

- migrate summary semantics out of normal assistant history
- make recent-turn retention and historical brief composition explicit

## Testing Strategy

### Unit tests

#### Budget normalization

Test all limit shapes:

- context only
- context + output
- context + input + output
- explicit input cap tighter than context-output remainder
- no output provided

#### Prompt budget thresholds

Test:

- floor margin
- proportional margin
- capped margin
- threshold equality and near-equality behavior

#### Prompt measurement

Test assembled prompt counting over:

- system-only prompts
- system + memory + tools
- tool-heavy sessions
- synthetic reminder injection
- summary/session-brief inclusion

### Integration tests

#### Provider-shape tests

- GPT-5.4-style `400k / 272k / 128k`
- Anthropic-style `200k / output only`
- model with only `context`

#### Compaction flow tests

- prompt below threshold: no compaction
- prompt above threshold: compaction before inference
- provider context-exceeded despite preflight: emergency fallback exactly once
- compaction reduces measured prompt size enough to proceed

#### Regression tests

- Anthropic cache-write spikes do not by themselves trigger extra compaction
- repeated compaction does not occur when measured assembled prompt stays below threshold
- multi-round sessions with summaries maintain continuity

## Observability

Each main-model call should log a single compact record:

```ts
{
  modelID,
  hardInputBudget,
  softCompactBudget,
  reservedOutput,
  safetyMargin,
  assembledPromptTokens,
  shouldCompact,
}
```

Provider usage should be logged separately:

```ts
{
  providerInput,
  providerOutput,
  providerReasoning,
  cacheRead,
  cacheWrite,
}
```

This makes it obvious whether a problem is:

- budget miscalculation
- prompt-measurement undercount
- provider-side tokenizer drift
- cache behavior

## Why This Is Better

This proposal reduces the mental model from:

- multiple checks
- multiple token semantics
- provider-specific cache distortions
- usage-driven control

to:

- one normalized budget
- one prompt measurement
- one trigger
- one fallback

It matches how robust systems tend to evolve:

- budgeting from model limits
- direct measurement of the actual prompt
- summarization as explicit state compression
- provider usage reserved for telemetry, not primary control

## Open Questions

1. should Synergy estimate prompt size locally only, or optionally ask providers for a native token count when available?
2. should synthetic post-compaction continuation remain transcript-visible, or become an internal loop control?
3. should `SessionBrief` live in transcript storage, a dedicated session field, or note-like side storage?
4. how aggressive should deterministic pruning be before LLM summarization?
5. should safety margins vary by provider family or remain model-agnostic?

## Recommended Next Step

Implement Phase 1 and Phase 2 only:

- add `PromptBudgeter`
- replace steady-state multi-check overflow logic with one budget/measurement decision
- keep current summary storage and emergency fallback temporarily

That is the smallest change that meaningfully simplifies the system without forcing a full session-state redesign in one pass.
