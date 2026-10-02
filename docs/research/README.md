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

[Codex harness 与 Synergy 缓存机制比较](context-efficiency/2026-09-28-codex-harness-cache-analysis.md)核对旧报告的 OpenAI-Codex 路由与原生 harness 的区别，比较固定版本的上下文更新、工具发现、reasoning 回放和增量传输，并区分源码机制与尚未测量的收益。

### UI API 5 frontend performance

[UI API 5 performance acceptance](2026-09-07-plugin-ui5-performance.md) records the same-machine production-build comparison, bounded rendering and plugin request counts for the public frontend extraction.

### 网络重试与恢复边界

[网络重试覆盖与恢复边界审查](2026-09-15-network-retry-audit.md) 记录 DNS/连接错误、SDK 与 worker 信息传递、HTTP/流错误、网页读取和工具重放的审查证据，并列出跨会话冷却与流式文本投影的后续范围。

### 编码观察与等待成本

[PR #1475 优化分析](context-efficiency/2026-09-28-pr1475-optimization-analysis.md) 对照最终合并实现，解释工具输出、编辑证据、固定提示、等待行为、benchmark 调度和原生可靠性的变化，并区分确定性收益与模型实验观察。

[上下文效率研究索引](context-efficiency/README.md) 按问题和实验顺序组织原始报告及数据，包含早期失败、来源选择、两题定向验证和最后候选 24 题覆盖；历史证据保持原样。

[等待提示后续诊断](context-efficiency/2026-09-24-process-waiting-followup.md) 区分子进程交互等待、命令失败、工具目录和缓存成本，并说明定向验证与完整 24 题覆盖分别回答的问题。

[八题双臂契约验证](context-efficiency/2026-09-28-quality-contract-diagnostic-study.md) 记录统一 evaluator 下的原生正确率、真实测试、逐请求用量及归档续验证据，区分一题净胜与双方仍失败题目的实际断言差异。
