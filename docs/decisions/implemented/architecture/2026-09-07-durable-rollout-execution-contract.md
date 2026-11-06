# Decision Record: Durable rollout execution contract

Status: implemented

## Problem

Session history is mutable product state: bounded tool previews and context pruning cannot independently preserve execution evidence. Prepared prompts can differ from provider-facing requests, auxiliary inference is not comprehensively attributed, and one-shot execution does not share the persistent server's complete configuration and shutdown lifecycle. Import-time feature flags also prevent isolated task-level experiments.

## Decision

Keep the existing Session, Scope, AgentTurn and Storage ownership boundaries. Add task-owned run, logical call, transport attempt, tool execution and artifact records. Record all normal tasks, preserve originals until explicit deletion, and stop further execution when authoritative persistence fails. Operational telemetry remains independently sampled and retained.

Use private, content-addressed binary chunks with independently committed progress records for large evidence. Capture observations before truncation and final provider requests after transformation. The Control Plane owns persistence; workers transfer bounded, acknowledged chunks. Preserve incomplete prefixes and unknown provider usage rather than claiming complete data or zero expenditure.

Normalize provider-specific token semantics before calculating expenditure. The pinned [OpenAI SDK 2.0.111](https://www.npmjs.com/package/@ai-sdk/openai/v/2.0.111) includes reasoning in output tokens, whereas [Google SDK 2.0.49](https://www.npmjs.com/package/@ai-sdk/google/v/2.0.49) reports candidates and thoughts separately. Preserve raw usage, calculation versions and price snapshots; derive all statistics from unique actual calls, excluding inherited and imported historical expenditure.

Share configuration, runtime ownership and awaited shutdown across one-shot and server execution. Move preview flags into their owning configuration domains, freeze task-local experiment settings and reject incompatible shared-runtime overrides. Extend existing send, export and stats surfaces with durable results, self-contained archives and descriptive comparisons.

## Alternatives considered

**Retain diagnostic logs longer.** Diagnostics omit or redact the required evidence and have a different failure policy; retention alone cannot recover missing requests or observations.

**Persist every payload inline in messages.** This duplicates large requests and outputs, increases write amplification and violates bounded streaming requirements.

**Build a separate rollout runner.** A second agent loop would reproduce the lifecycle divergence and make experiments measure different execution paths.

**Keep process-wide experiment flags.** Concurrent tasks could silently share or overwrite treatment settings, making comparisons unreliable.

## Verification

- Original observations survive truncation, pruning, source failure and export.
- Per-attempt request records match a deterministic provider's received bytes, including rewrites and retries.
- Reasoning, caches, auxiliary calls, child tasks, forks and imports have explicit, nonduplicated accounting.
- Recording failures stop admission of new calls and never emit a successful durable result.
- One-shot and attached execution apply equivalent task semantics and await owned work before termination.
- Concurrent task experiments do not modify global environment state; shared-resource mismatches fail explicitly.
- Versioned migration and archive validation retain historical evidence and distinguish missing data.
- Public contracts, generated clients, UI consumers, documentation and behavioral tests agree.

## Consequences

Complete recording increases disk use and write traffic; bounded chunking limits memory but does not eliminate storage cost. Provider-internal activity and unreported billing remain unknowable and must be marked accordingly. Exact requests do not freeze an external execution environment. Historical data cannot be reconstructed beyond surviving evidence. This change does not introduce a benchmark, scorer or new context algorithm.

## Implementation

The session rollout ledger owns durable events, artifact references and fixed-boundary archives. Existing product ports supply plugin metadata without reversing harness-core layering. `RuntimeHandle` owns process initialization and shutdown; `Experiment` captures immutable task values separately from actual shared-resource values. [Rollout execution](../../../reference/rollout.md) is the public usage contract.

Behavioral coverage uses temporary Scope/storage, local deterministic provider streams and subprocess fixtures. It covers retries, failed persistence, migration reentry, auxiliary calls, imported accounting, prefix-preserving archives, process cancellation and non-interactive CLI commands. Performance measurements use the existing isolated session-memory runtime workload; no benchmark score or quality improvement is inferred from these execution checks.

File snapshots use the owning snapshot archive/lease contracts during rollout ZIP transfer. Fork and import retain both file objects and rollout originals; explicit deletion releases each domain only after its references are removed. The integration preserves concurrent schema publication inside explicit runtime initialization.

Public Cortex cancellation remains non-blocking after durable status publication. Explicit task drainage is reserved for rollout finalization and runtime shutdown, including descendants, so ordinary cancellation does not wait on processors while final evidence cannot race resource disposal.

Experience maintenance that has only stored content and no original user message records an independent Scope operation with source session/message metadata. It must not fabricate a session root to satisfy attribution; normal encoding with an actual triggering user retains session ownership.

Timeout fixtures attach rejection handling before awaiting hook entry and allow evidence persistence before exercising a deliberately stalled handler. Storage spies only count writes in their fixture directory. These assertions retain timeout and atomic-write guarantees without coupling them to unrelated asynchronous work or a ten-millisecond disk budget.
