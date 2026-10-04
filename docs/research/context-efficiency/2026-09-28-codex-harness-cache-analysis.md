# Codex harness 缓存机制与 Synergy 差异分析

本文回答三个问题：仓库里“Codex 缓存命中率很高”的证据实际测了什么；Codex 怎样保留可复用的模型输入；PR #1475 合并后的 Synergy 还可以改进什么。它是针对 PR #1475 合并基线的源码与历史实验分析，没有启动新的付费模型实验。分析后的首阶段改造见[持久 advisory context 决策](../../decisions/implemented/architecture/2026-09-28-durable-prompt-context.md)，下文保留基线对照，不把这些缺口继续作为新实现的结论。

结论是：Codex 最值得借鉴的是把模型已经看过的上下文作为可重放的记录，普通续跑尽量只追加新记录。Synergy 已经实现动态内容后置、会话缓存键和兼容的加密 reasoning 回放；进一步的差距主要在动态上下文是否进入历史、工具展开是否改变前置定义，以及对最终请求前缀变化的验证。仓库已有数据不能给出“Codex 原生 harness 比 Synergy 高多少”的同条件因果结论。

## 1. 证据范围与版本

| 对象             | 本文固定的证据                                                                                       | 能回答的问题                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Synergy          | PR #1475 合并提交 `909fb14b6ca65418cfb8cf402da075419c077db4`                                         | 最终合并版本的实现；不把历史缺陷继续当成现存缺陷                            |
| Codex            | OpenAI 开源仓库 `44fe510ce3ee61c8ef623adcbf89b901c73ddd61`，提交日期 2026-09-28                      | 公开 harness 的源码与测试；不代表每个客户端、模型或功能开关都启用了全部路径 |
| 旧 KV-cache 报告 | Synergy 历史提交 `9673cd8cf6c092f37af68c32b2a0dba3b964def3` 的 `docs/kvcache-measurement-results.md` | 当时 Synergy 调用 OpenAI-Codex、DeepSeek 的布局优化效果                     |
| PR #1475 实验    | 本目录 09-24 的 GLM 候选 24 题报告、等待后续诊断                                                     | token、请求和缓存的实际统计；不能替代原生 Codex 对照组                      |

公开源码的检出版本晚于旧 KV-cache 实验。下文对新能力只分析机制，不倒推它们已经在历史实验中生效。当前架构定义仍见 [LLM loop](../../architecture/llm-loop.md)；PR #1475 的完整优化范围见 [PR #1475 分析](2026-09-28-pr1475-optimization-analysis.md)。

### 1.1 找到的 97.60% 是 Synergy 自己的结果

[研究总索引](../README.md#provider-kv-cache-investigation) 指向已归档到 Git 历史的六份 KV-cache 报告。[原始测量报告](https://github.com/SII-Holos/synergy/blob/9673cd8cf6c092f37af68c32b2a0dba3b964def3/docs/kvcache-measurement-results.md) 使用 agent `synergy-max`，通过 Synergy CLI 调用 `openai-codex/gpt-5.3-codex-spark`；每个会话连续四轮，每轮要求至少三个真实工具调用，并交替执行基线与候选。其 OpenAI-Codex 表格为：

| 用户轮次 | 基线 hit | 优化后 hit | 基线 miss token | 优化后 miss token | 报告给出的 miss 变化 |
| -------- | -------: | ---------: | --------------: | ----------------: | -------------------: |
| 2        |   88.16% |     97.60% |        10,609.0 |           2,142.5 |               -79.8% |
| 3        |   92.45% |     97.15% |        21,867.5 |          14,104.5 |               -35.5% |
| 4        |   93.45% |     94.59% |         9,397.5 |           8,854.5 |                -5.8% |

这里的 OpenAI-Codex 是 provider 路由，执行循环仍是 Synergy。数据证明 Synergy 在这条路由上也能获得高命中，并支持“把易变内容移到历史之后有收益”。它不能证明 Codex CLI 与 Synergy 的性能差距。报告还明确指出第三轮候选有更多模型步骤和工具调用，因此总输入更高；hit 上升并不自动等于总成本下降。表中数值沿用原报告的精度，没有把这些分组统计重新合成为总体命中率。

在本次检查的已跟踪研究文档及上述历史报告中，没有找到带同模型、同后端、同任务条件的原生 Codex / Synergy 缓存配对结果。因此后文的比较分为“源码已证实的机制差异”和“仍需实测的收益”，不补造 Codex 的总体命中率。

### 1.2 PR #1475 的 GLM 结果属于另一组实验

从[最终候选 JSON](2026-09-24-local24-candidate-study.json) 的 `full_population` 重算，使用 token 加权口径 `sum(cacheRead) / sum(input)`：

| 指标                    |    历史基线 |    最终候选 |
| ----------------------- | ----------: | ----------: |
| 总 input                | 175,847,711 | 122,615,621 |
| cache read              | 141,237,440 | 103,875,328 |
| 加权缓存命中率          |    80.3180% |    84.7162% |
| 未缓存 input            |  34,610,271 |  18,740,293 |
| 请求数                  |       3,108 |       1,624 |
| 平均 input / 请求       |   56,579.06 |   75,502.23 |
| 平均未缓存 input / 请求 |   11,135.87 |   11,539.59 |

候选的加权 hit 增加约 4.40 个百分点，未缓存输入总量减少 45.85%，同时请求数减少 47.75%。但每次请求的平均输入和平均未缓存输入都没有下降。这说明组合收益包含更少的推理轮次和不同的轨迹长度，不能全部归因于“每次请求缓存更好”。这里是 Boyue GLM 历史基线与新候选的跨批次比较，不能拿 84.72% 与旧 OpenAI-Codex 单个轮次的 97.60% 相减，声称得到 harness 差距。实验条件与质量限制见[候选报告](2026-09-24-local24-candidate-study.md)。

## 2. 从模型真正接收的输入理解缓存

这里讨论的是服务端模型输入的 KV-cache 复用。Synergy 的 `SessionMessageCache`、Codex 的本地历史容器或工具目录缓存可以减少本地读取与组装开销，但不是 provider 返回的 `cached_tokens`。

对请求 i，记总输入为 `I_i`、缓存读取为 `C_i`，则本目录数据中的未缓存输入为 `U_i = I_i - C_i`，总体命中率为 `sum(C_i) / sum(I_i)`。cache read 已包含在 input 中，不能再加到 input 上。不同 provider 对 cache write 的报告方式不同；本批 GLM 的 cache write 为未知，不能按零写入成本计算费用。

缓存复用依赖服务端实际展开后的输入前缀相同，还受到缓存是否存在、请求路由和模型规则约束。文本语义相同不够，单看 system 哈希相同也不够；工具定义、消息顺序、reasoning、输出格式等请求配置都可能影响模型看到的前缀。OpenAI 的[官方缓存说明](https://developers.openai.com/api/docs/guides/prompt-caching)也要求保留历史与工具定义，并区分不同模型的规则。

假设一轮有 64,000 个可复用 token，新增 2,000 个 token，理想命中率就是 `64,000 / 66,000 = 96.97%`。这是解释高命中率的示例，不是 Codex 的测量结果。长编码会话每步通常只增加少量动作和反馈，所以只要历史前缀保留下来，超过 95% 在算术上并不意外。

需要区分三件事：保留前缀提高可命中的上限；provider 实际是否命中要看返回 usage；缩短总轨迹、减少固定提示和无效工具输出才能降低任务总开销。为了把百分比做高而保留无用的大上下文，会让指标好看而任务更贵。

## 3. 最重要的差别：后置动态内容与追加式上下文记录

### 3.1 Synergy 已经保护了已有历史

[PromptCachePolicy](../../../packages/harness/src/provider/prompt-cache-policy.ts) 对 OpenAI、OpenAI-Codex、DeepSeek、Anthropic，以及指定的 OpenAI、Azure、OpenAI-compatible SDK 路由使用 `late-user-context`。[LLM.promptMessages](../../../packages/harness/src/session/llm.ts) 在这些路由上构造：

```text
稳定 system → 已有历史 messages → 本次 runtime-context
```

这比把每轮变化的记忆、环境和提醒放在历史前面更好：尾部变化不会使它之前的历史失去匹配机会。旧报告中 88.16% → 97.60% 的结果正是在 Synergy 内验证这类布局改动。

但 `runtime-context` 是调用时生成的用户消息。`promptMessages()` 把它追加到本次返回的数组；该函数没有把它写回会话历史。[invoke.ts](../../../packages/harness/src/session/invoke.ts) 每步组装 `lateSystemParts`，其中包含 Library recall、环境、Git health、coauthor、领域提醒及部分时间提示。下一次输入由持久消息重新投影，再附加新的 runtime context。

设 S 为稳定提示，H 为当前历史，R 为运行时上下文，A 为模型生成的工具调用，T 为工具结果，则正常路径可以表示为：

```text
Synergy 第一次输入：S | H | R1
模型生成：                 A1
工具返回：                 T1
Synergy 第二次输入：S | H | A1 | T1 | R2
前一请求可直接匹配的公共前缀：S | H
```

即使 R1 与 R2 文本完全相同，它们在序列中的位置也改变了。第二次请求保住了 H，但不是对第一次完整输入 `S | H | R1` 的追加，也不能直接复用位于 R1 之后的 A1 那段生成状态。这个判断来自消息组装路径，不是已测出的 token 损失；实际命中还由 provider 的分块与缓存规则决定。

这个缺口通常影响尾部，不能用它单独解释“整次 cache read 为 0”。当 H 很长时，Synergy 仍然可以有很高的 hit。要证明它造成多少 miss，需要逐步最终请求的前缀差分与 usage 对齐。

### 3.2 Codex 把上下文变更记入会话

Codex 的 [record_context_updates_and_set_reference_context_item](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/session/mod.rs#L4658) 保存参考上下文：首次注入完整上下文，之后比较 world state 与 turn context，生成变化项；变化项通过 `record_conversation_items` 加入历史，再持久化对应快照。无变化时无需重复发送同一环境块。

普通续跑的目标结构更接近：

```text
Codex 第一次输入：S | H | R1
模型生成：                A1
工具返回：                T1
Codex 第二次输入：S | H | R1 | A1 | T1 | ΔR2
前一请求的输入及响应都保留原顺序，后面只追加新项
```

如果环境没有变化，`ΔR2` 可以不存在。权限、工作目录等状态改变时，追加的是相应角色的上下文更新，不需要为了描述新状态重写早先消息。权限执行仍由真实运行时状态决定，缓存不能成为保留过期授权的理由。

这不是仅凭注释判断：[prompt_caching 测试](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/tests/suite/prompt_caching.rs) 包含 `overrides_turn_context_but_keeps_cached_prefix_and_key_constant`、`per_turn_overrides_keep_cached_prefix_and_key_constant`、`send_user_turn_with_no_changes_does_not_send_environment_context` 等用例，检查请求中的旧消息、追加更新和缓存键。相比之下，Synergy 的 [kvcache-measurement 测试](../../../packages/harness/test/session/kvcache-measurement.test.ts) 主要验证固定 history 下两份动态上下文的公共前缀，以及最终消息顺序；它没有在这些用例中证明“上一完整输入和响应是下一请求的前缀”。

可以借鉴的是模型可见上下文的持久化与变更语义，不能简单地把完整 R 每步存一份。后者会重复保存记忆、过期提醒和环境信息，增加上下文和存储，并影响压缩、恢复与跨模型投影。合理方向是区分稳定快照、需要持久化的变更和一次性提醒，再明确各自的失效与压缩规则。

### 3.3 稳定 system 也需要检查真实变更

Synergy 的前置 system 不只有 agent 文本。[invoke.ts](../../../packages/harness/src/session/invoke.ts) 还加入项目指令、权限、Cortex 执行上下文、workflow 的 `buildSystem` 和 execution contributions；[LLM.prepare](../../../packages/harness/src/session/llm.ts) 允许最终 system transform。只要其中某一项变化，后面的历史就可能无法复用此前的前缀。

这些入口具备改变前缀的能力，不等于它们在当前实验中都改变了。应测量每个分区的实际变化，不能根据“每步重新构造”就认定缓存失效：重建相同内容本身不会破坏匹配。同样，[environment](../../../packages/harness/src/session/system.ts) 中的日期是日历日期，创建时间通常固定，不能仅凭组装注释把它说成每次请求都会变化的时间戳。

## 4. 工具定义：少发与保持稳定需要同时考虑

Codex 的 [prompt_tools_are_consistent_across_requests](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/tests/suite/prompt_caching.rs) 检查跨请求的工具集合。支持原生 tool search 的路径中，[ToolSearchHandler](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/tools/handlers/tool_search.rs#L225) 把选中的工具返回为 `ToolSearchOutput`；其 [to_response_item](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/tools/context.rs#L222) 生成带完整工具定义的历史项，工具描述按需进入后续上下文。工具搜索规格还使用有序映射整理来源描述，降低无意义顺序变化。[工具定义转换](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/tools/src/tool_search.rs#L75)为搜索结果设置 `defer_loading`。这条能力的可用性依赖模型与路由，不能推断所有 Codex 请求都使用它。

Synergy 也有 [ToolExposure](../../../packages/harness/src/tool/exposure.ts) 的 resident/group/search 模式和 [ToolDiscovery](../../../packages/harness/src/tool/discovery.ts)。差别是 [ToolResolver](../../../packages/harness/src/session/tool-resolver.ts) 根据 `session.toolState` 等状态筛选 `visible`，再把可见工具映射成本轮 `definitions`。工具展开改变可见集合时，后续请求的顶层工具定义也可能改变。对把工具定义编码在消息前面的 provider，这可能比 runtime context 的尾部变化影响更大。

[等待后续诊断](2026-09-24-process-waiting-followup.md) 确实观察到工具数由首轮 30 变为后续 36，之后工具定义保持稳定；后续每轮定义序列化体积为 134,431 字节，system 为 44,758 字节。两题首个主请求已经有约 3.4 万 input token。这说明固定目录与说明是实质成本来源，但字节占比不是 token 或费用占比，不能原比例推算收益。

PR #1475 已对 agent 目录重复说明做了精简；[已有分析](2026-09-28-pr1475-optimization-analysis.md) 记录最终 agent system 加 31 个第一方工具定义的总字节从 150,942 减到 127,184，约 -15.74%。这是保留能力前提下的描述去重，不是原生 tool search，也没有证明动态展开从此不影响前缀。

后续应分别评估两个变量：常驻定义是否还能减少冗余；已开始的上下文中如何引入新工具而尽量不改变前置定义。对缺少原生 tool-search 协议的兼容 provider，不能只把 schema 写进普通工具结果就假定模型能合法调用它。必须保持真实工具注册、调用校验和权限执行；必要的目录变更可以接受一次缓存损失。

## 5. 哪些 Codex 能力 Synergy 已经具备

| 机制                   | Codex 公开实现                                    | PR #1475 合并后的 Synergy                                   | 判断                           |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------- | ------------------------------ |
| 稳定提示与已有历史优先 | 初始上下文与历史记录                              | stable system + messages + late context                     | Synergy 已做基础优化           |
| 会话级缓存身份         | `prompt_cache_key`，ChatGPT 路由的 session header | `promptCacheKey = sessionID`，Codex fetch 设置 `session_id` | 不是缺一个 key                 |
| 动态上下文更新         | 初始快照与持久化差分                              | 每步重建后置 runtime context                                | 有进一步改进空间               |
| 工具发现               | 支持的路径用原生 `ToolSearchOutput` 装入定义      | 分组/搜索后更新可见 definitions                             | 能力都有，协议与前缀影响不同   |
| reasoning 回放         | 保留 Responses items，请求加密 reasoning          | 符合 producer identity 与 ciphertext 条件才回放             | 关键缺陷已修复，不能重复算缺口 |
| 工具输出截断           | 记录工具响应时执行 truncation policy              | PR #1475 在工具观察入口限制反馈体积                         | 方向一致，具体覆盖与预算不同   |
| 增量传输               | 支持时使用 WebSocket continuation                 | 本文检查的 Codex 路由经 SDK/fetch 发请求                    | 主要是传输与延迟差异           |
| 前缀回归验证           | 跨轮 override、无变更、工具一致性等请求测试       | 已有 provider policy 与布局测试                             | 可补完整续跑与最终 wire 验证   |

### 5.1 缓存键已经传到 Codex 后端

Synergy 的 [ProviderTransform.options](../../../packages/harness/src/provider/transform.ts) 对符合策略的模型设置 `promptCacheKey = sessionID`；[codexFetchFor](../../../packages/harness/src/provider/codex.ts) 从序列化 body 读取 `prompt_cache_key`，设置 `session_id` 和 `x-client-request-id`。Codex 的 [client.rs](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/client.rs#L575) 同样维护缓存键与会话标头的关系。因此不能把高命中简单归因于“Codex 有缓存键，Synergy 没有”。

键只是请求身份或路由机制的一部分，不能恢复已经变化的前缀，也不是永不失效的缓存句柄。OpenAI [现行官方文档](https://developers.openai.com/api/docs/guides/prompt-caching)把 GPT-5.6 及之后与更早模型的 key、保留期规则分开说明；不能把某条 Platform API 文档的 TTL 直接套到历史 Spark、GLM 或 ChatGPT OAuth 路由上。

### 5.2 加密 reasoning 的历史缺陷已经修复

Codex [构建 Responses 请求](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/client.rs#L884) 时包含 `reasoning.encrypted_content`，并在历史中保留相应 ResponseItem。这里不仅是保存供人阅读的思考摘要，还包括后续推理可复用的加密状态。

Synergy 的[已实施决策](../../decisions/implemented/bug-fix/2026-09-23-replay-only-encrypted-codex-reasoning.md)记录了旧投影丢弃 reasoning ID 与 ciphertext 的问题。最终合并代码只在生产者与当前请求的 canonical profile、connection provider ID 和 wire model ID 一致，且存在非空 ciphertext 时回放完整 reasoning item；remote compaction 使用相同检查。旧数据缺失的密文不能补造，切换模型或账号也不能强行复用。

这项修复对有效推理历史很重要，但属于合并版本已经具备的能力。不能把旧实现的丢失继续作为当前 Synergy 命中低的解释，也没有这次实验的数据能把独立收益精确归因给它。

## 6. 传输、裁剪与新能力需要单独判断

### 6.1 WebSocket continuation 不等于更高的 cached-token 百分比

Codex 的 [get_incremental_items](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/client.rs#L1379) 会比较模型、instructions、tools、reasoning 等非 input 属性，并检查当前 input 是否保留“上一 input + 服务端返回的 response items”。满足条件才仅发送后续 items，并带 `previous_response_id`；否则改发完整上下文。传输中的前缀检查因此还能暴露历史是否保持一致。

这减少重复上传、序列化与连接相关开销，但模型仍然要在完整逻辑上下文上工作，服务端 usage 仍是判断输入复用的依据。完整 HTTP 请求也可以命中缓存。不能因为 WebSocket 请求 body 更小，就宣称 input token 或费用按相同比例减少。

### 6.2 入历史前限制输出，比频繁改写旧输出更容易保留前缀

Codex 的 [History::record_item_with_metadata](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/context_manager/history.rs#L530) 在记录工具输出时执行截断策略，再把处理后的项追加到历史；完整 rollout 与模型使用的历史可以分别保留。这样的入口限制避免把很大的临时输出先塞进模型历史、随后立刻删掉。Synergy PR #1475 的 bounded tool observations 也在推进相同方向。

Synergy 的 [selectPartsToPrune](../../../packages/harness/src/session/compaction.ts) 另有历史工具输出清理：跳过最近两个用户回合，保护一定量的近期工具内容，超过最小可清理量后标记旧 part；[MessageV2 投影](../../../packages/harness/src/session/message-v2.ts) 将其输出替换成清除标记。这会改变对应位置的模型历史，可能使该点以后的旧前缀失去复用，但也能减少上下文压力。需要在节省的后续输入与重建成本之间判断，不能简单禁用。

Codex 同样存在 compaction、历史归一化、回滚和恢复路径，追加式记录只描述正常续跑的目标，不是“任何情况下都不改历史”的保证。尤其本目录[两题诊断](2026-09-24-process-waiting-followup.md)记录该批没有 compaction，并未实施所讨论的历史裁剪，所以不能把这些潜在影响说成该批 cache miss 的已证实根因。

### 6.3 新增 reasoning-effort 更新路径不能倒推历史收益

公开 Codex 版本还包含 [reasoning_effort.rs](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/session/reasoning_effort.rs)：在支持的模型与启用条件下，把 reasoning effort 变化记为 `ConfigurationUpdate`，保留该上下文窗口的请求级 effort 基线，以减少隐藏提示变化。所检查的 [feature 配置](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/features/src/lib.rs#L1710)将 `ReasoningEffortOverride` 标为开发中且默认关闭，client 还检查 provider 和模型能力。

它说明 Codex 在继续扩大“追加变化、保留原前缀”的适用范围，但不是所有用户已启用的默认能力，也不能解释旧 Spark 实验的 97.60%。Synergy 如需引入，应该作为明确的 provider/model capability，而不是向所有 OpenAI-compatible 模型发送新 item。

## 7. provider 因素为什么仍然不能排除

[等待后续诊断](2026-09-24-process-waiting-followup.md)发现：CompCert 的 49 次主请求中有 19 次 cache read 为 0，Mailman 的 35 次中有 7 次；两者的 system 哈希各自恒定，工具目录从第二轮起也稳定。CompCert 中，距离上一请求结束至少 60 秒的 12 次请求有 10 次为零缓存；较短间隔的 36 次中有 8 次为零缓存。

这些数据支持“需要同时检查请求间隔与最终前缀”，不能推出 provider 的 TTL 恰为 60 秒，也不能证明负载均衡、上下文裁剪或任一具体因素是根因。system 与 tools 稳定，没有覆盖全部历史、加密项、请求配置与服务端展开。尾部变化通常保留一段长前缀，大量零缓存尤其需要把本地首个差异位置与后端返回的 usage 对齐。

原生 Codex 与 Synergy 如果分别用了 OpenAI 和 Boyue GLM，还混入模型、tokenizer、缓存实现、网关和请求时序差异。仅替换 harness 而不固定这些条件，不能把最终 hit 差值全部归给 harness。公开源码也无法证明 Codex 客户端获得了未公开的缓存保证。

## 8. 对 Synergy 的建议与最短验证路径

这些是根据当前差异提出的后续方向，未在本次分析中实施。优先级按“先定位可控损失，再做最小行为改动”排列。

进一步的实现设计见[追加式模型上下文提案](../../decisions/proposed/architecture/2026-09-28-append-only-model-context.md)，其中核对了 Codex 的 section snapshot、变化记录、恢复和压缩，并列出 Synergy 的存储选择、消息顺序、消费者修复与分阶段验收。

| 优先级 | 工作                                                       | 验证它解决了什么                                                          | 需要保持的行为                                           |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| P0     | 在最终 provider 请求处记录脱敏的分区指纹与首个变化位置     | 区分 system、tools、历史、动态尾部、模型参数变化与无法解释的后端 miss     | 不记录原始提示、密文或秘密；使用安全的摘要/标识          |
| P1     | 为 runtime context 设计首次快照、变更记录与一次性提醒      | 验证普通工具续跑时，上一模型输入与输出能否完整留在下一输入的前部          | 权限立即生效，过期提醒失效，resume/compaction 不重复注入 |
| P1     | 固定每个普通续跑阶段的工具定义与顺序，能力展开显式形成变更 | 找出 30 → 36 这类定义变化对前缀的影响；对支持的 provider 评估原生工具发现 | 工具真实可调用，权限与模型能力不被缓存快照覆盖           |
| P1     | 在不损失工具能力的前提下继续去重常驻说明                   | 同时降低冷启动、miss 和 cache-read 的输入量                               | 以完整任务质量验证，不按两题未调用就删工具               |
| P2     | 依据实际首个差异位置与后续复用次数评估历史裁剪时机         | 判断裁剪节省的累计输入是否覆盖前缀重建成本                                | 保留上下文预算、工具证据和 compaction 恢复能力           |
| P2     | 对已支持的 Codex 路由独立评估增量传输                      | 测上传字节、首 token 延迟、重连及退回完整请求                             | 不以小 body 代替真实 token 账单，不影响其他 provider     |

第一步不需要重跑完整 local24。先用免费的确定性请求捕获验证：普通工具续跑；环境未变化；权限或工作目录变化；工具展开；resume；加密 reasoning 回放；历史裁剪和 compaction。断言应针对 SDK 转换、provider rewrite 与 replay splice 之后的请求，不能只停留在内部 `ModelMessage[]`。需要同时检查角色、工具调用/结果对应关系和执行权限，不能只验字符串前缀。

实时实验应把两个问题拆开。验证“布局本身是否改善”时，固定 provider、wire model、账号/路由、任务、输出预算和请求时序，用相同录制历史比较当前布局与候选布局；验证“实际任务是否更省”时，再做允许模型自由执行的小规模配对，并记录步骤差异。原生 Codex / Synergy 的产品比较是后一类，工具与提示差异必须显式报告，不能假定只是换一个循环实现。

每组至少报告：任务完成与真实测试结果，总 input、cache read、未缓存 input、output、请求数、首 token 延迟、总耗时、工具定义变化、历史重写事件，以及请求间隔。冷启动、稳定续跑、工具展开后、压缩后分开看。最终以完成相同工作的总开销判断改进，不只追求 hit 百分比。

## 9. 本次验证与剩余限制

已读取双方固定版本的请求组装、上下文更新、工具定义、reasoning、传输和历史处理路径，并核对相应测试。Synergy 实际执行了 `bun test test/session/kvcache-measurement.test.ts test/provider/prompt-cache-policy.test.ts`，结果为 11 pass、0 fail、39 assertions；这证明现有布局与策略测试通过，不证明线上缓存收益。本文的 GLM 加权 hit 与每请求均值从已保存 JSON 重算。

未执行 Codex Rust 测试，未调用付费 provider，未重新运行 local24，也没有可用于归因的同条件原生 harness 配对数据。本文建议所带来的 token、费用和延迟收益仍需按上面的分层方法测量。

## 源码与外部资料

外部源码链接固定到本次检查的提交，避免主分支持续变化后无法复核。OpenAI 官方文档只用于解释公开缓存语义；上述主要实现判断以固定源码和仓库实验为证据。

- [S0：Synergy 历史 KV-cache 测量报告](https://github.com/SII-Holos/synergy/blob/9673cd8cf6c092f37af68c32b2a0dba3b964def3/docs/kvcache-measurement-results.md)。
- [C1：Codex 上下文差分与持久化](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/session/mod.rs#L4658)；[C2：前缀、工具与 override 回归测试](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/tests/suite/prompt_caching.rs)。
- [C3：原生工具搜索处理](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/tools/handlers/tool_search.rs#L225)；[C4：工具搜索响应项](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/tools/context.rs#L222)；[C5：按需工具定义](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/tools/src/tool_search.rs#L75)。
- [C6：缓存键与 session header](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/client.rs#L575)；[C7：Responses 请求构建](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/client.rs#L884)；[C8：增量传输前缀检查](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/client.rs#L1379)。
- [C9：工具输出入历史时的截断](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/context_manager/history.rs#L530)；[C10：reasoning effort 更新](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/session/reasoning_effort.rs)；[C11：功能启用条件](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/features/src/lib.rs#L1710)。
- [O1：OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)；[OpenAI 对 Codex agent loop 的公开说明](https://openai.com/index/unrolling-the-codex-agent-loop/)。
