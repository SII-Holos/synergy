# Research

Research documents preserve investigations, measurements, experiments, and design exploration that explain how Synergy reached a conclusion. They are evidence, not the contract for current supported behavior. Code, tests, and the owning product, architecture, reference, plugin, or operations document remain authoritative.

## Research Lifecycle

- State the question, scope, date or implementation baseline, evidence, uncertainty, and disposition.
- Keep raw credentials, prompts, user content, private endpoints, local paths, and runtime identifiers out of committed artifacts.
- Move an accepted current-state invariant into its owning canonical document when implementation lands.
- Retain a research artifact when its measurements or rejected alternatives remain useful. Summarize and retire it when point-in-time source locations, provider behavior, or run-specific detail would otherwise be mistaken for a current contract.
- Use [Migration history](../migrations/README.md) instead when the subject is a shipped storage, schema, naming, or compatibility transition.

## Preserved Research Summaries

### Runtime performance investigation

The former `docs/architecture/runtime-performance.md` was an implementation investigation rather than a durable architecture contract. It was retired from the working tree because its source locations and implementation-status table describe one point in repository history. The full report remains available in Git history at its former path.

Its durable findings were:

- Streaming work can become quadratic when every delta reserializes accumulated content, rereads session ownership, or forces full Markdown rendering.
- A loop-scoped, single-writer message cache can remove repeated session-history reads without changing persisted message authority.
- LSP processes, Browser pages, and other heavy resources require explicit ownership and reclamation rather than process-lifetime retention.
- Per-operation observability can amplify the hot path it is measuring; instrumentation cost and queue behavior need measurement of their own.

The investigation recorded delta/checkpoint transport, session message caching, LSP and Browser reclamation, cheaper metric writes, incremental streaming Markdown, sanitization, and storage serialization improvements as implemented at that time. It deliberately left broader ScopeRuntime disposal, metric pre-aggregation, streaming observability queries, and Stats caching for separate evaluation.

Current contracts live in [Frontend data sync](../architecture/frontend-data-sync.md), [Sessions and messages](../architecture/session-and-messages.md), [Runtime and Scope](../architecture/runtime-and-scope.md), and [Performance observability](../operations/performance-observability.md).

### Provider KV-cache investigation

The former KV-cache series combined a source baseline, provider research, a proposed prompt-region model, a deterministic harness, live measurements, and final validation. The six long-form artifacts were retired after this summary because they contain Blueprint-specific run metadata, time-sensitive provider capabilities, source locations, and experiment results that should not be read as permanent provider guarantees. Their full text remains available in Git history under the former paths listed below.

Durable conclusions:

- Cacheability follows the longest byte-stable prefix. Volatile context placed before reusable history shortens that prefix even when a stable session cache key is present.
- Prompt layout must remain provider-aware. OpenAI-style automatic prefix caching and Anthropic explicit breakpoints do not have one interchangeable optimal layout.
- Core agent/project instructions, permission and governance context, tool schemas, and run contracts must retain authority and deterministic ordering; cache gains do not justify moving or weakening them without behavioral proof.
- Advisory memory, environment, time, repository health, and similar context may be candidates for a late dynamic region only when role semantics and tests preserve behavior.
- Compaction intentionally changes the reusable prefix. Cache observability should use token counts, region sizes, fingerprints, and provider metadata rather than raw prompt text.
- Deterministic prompt-shape tests should precede live provider experiments, and live comparisons must use isolated runtimes while reporting model-step and tool-call noise alongside cache metadata.

The recorded validation found that the implemented OpenAI-style layout preserved reusable history before volatile advisory context, kept tool-call history ordered, and retained an Anthropic stable breakpoint. Repeated-turn OpenAI-Codex and explicitly gated DeepSeek experiments generally reduced provider-reported miss tokens, while also showing that live agent runs are noisy and that generic OpenAI-compatible providers require conservative capability checks.

Open questions intentionally left for later work included advanced Anthropic TTL, multi-breakpoint, diagnostics, and prewarming behavior; broader compatible-provider qualification; cache-aware compaction timing; and the external expectations of prompt-transform hooks. These are research inputs, not promises of current support.

| Former path                               | Preserved role                                      | Disposition                   |
| ----------------------------------------- | --------------------------------------------------- | ----------------------------- |
| `docs/kvcache-baseline-report.md`         | Source and provider-route baseline                  | Summarized; long form retired |
| `docs/kvcache-best-practices-research.md` | Provider and literature findings                    | Summarized; long form retired |
| `docs/kvcache-strategy-design.md`         | Prompt-region and provider-layout design            | Summarized; long form retired |
| `docs/kvcache-measurement-harness.md`     | Deterministic and isolated live-measurement method  | Summarized; long form retired |
| `docs/kvcache-measurement-results.md`     | Deterministic tests and live provider observations  | Summarized; long form retired |
| `docs/kvcache-validation-result.md`       | Quality, risk, and remaining-uncertainty assessment | Summarized; long form retired |

Current prompt assembly and compaction contracts live in [LLM loop and compaction](../architecture/llm-loop.md). Current provider configuration belongs in [Configuration](../reference/configuration.md); operational performance evidence belongs in [Performance observability](../operations/performance-observability.md).
