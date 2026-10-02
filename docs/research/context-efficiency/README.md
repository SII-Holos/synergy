# 上下文效率研究索引

本目录保存 PR #1475 的工具观察、等待行为和基准实验研究，以及 Codex harness 与 Synergy 的缓存机制比较。它是历史证据索引；产品支持范围以源码、测试和所属架构文档为准。

先读 [PR #1475 优化分析](2026-09-28-pr1475-optimization-analysis.md)：它对照最终合并代码，解释各项改动、实测收益、负面结果和证据限制。需要逐题评分、请求、工具轨迹和费用字段时，再进入下表的原始报告。

缓存问题见 [Codex harness 缓存分析](2026-09-28-codex-harness-cache-analysis.md)：包含旧 KV-cache 报告的来源辨析、GLM 加权命中率重算、双方源码对照，以及动态上下文与工具定义的进一步优化方向。

具体改造方案见[追加式模型上下文提案](../../decisions/proposed/architecture/2026-09-28-append-only-model-context.md)：解释 Codex 的 snapshot、语义变化与恢复机制，并给出 Synergy 的持久消息设计、调用顺序、provider 能力分层和验收范围。第一阶段已按[持久 advisory context 决策](../../decisions/implemented/architecture/2026-09-28-durable-prompt-context.md)落地，后续 provider 指令与工具协议仍保留在提案中。

## 按问题查找

| 问题                                       | 主要证据                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR 最终交付了哪些优化，哪些还没有证明？    | [优化分析](2026-09-28-pr1475-optimization-analysis.md)                                                                                                                    |
| 工具输出本身缩小了多少？                   | [固定输入测量与 DeepSeek 小样本](2026-09-21-coding-observations-pilot.md)                                                                                                 |
| 最完整的一轮候选覆盖结果是什么？           | [候选 24 题最终报告](2026-09-24-local24-candidate-study.md)，附同名 JSON、CSV                                                                                             |
| 最终报告使用的历史基线从哪里来？           | [故障修复后的来源选择视图](2026-09-23-local24-glm-fault-repair-study.md)，附 76 次尝试                                                                                    |
| 为什么不能仅凭减少工具输出就认定任务更省？ | [早期小样本](2026-09-21-coding-observations-pilot.md)、[两题后续诊断](2026-09-24-process-waiting-followup.md)                                                             |
| 为什么要修改等待提示和删除重复说明？       | [等待实验](2026-09-24-process-waiting-study.md)、[后续诊断](2026-09-24-process-waiting-followup.md)、[通用提示与去重实验](2026-09-24-general-guidance-study.md)           |
| 环境、评分和归档故障怎样影响结论？         | [基础设施审计](2026-09-22-local24-infrastructure-audit.md)、[GLM 配对研究](2026-09-23-local24-glm-paired-study.md)、[独立 Boa 重判](2026-09-23-boa-dependency-regrade.md) |

## 实验顺序与文件职责

“V7/V9/V10/V11”是执行或 evaluator 批次；“repro-v6”是题目依赖变体；它们不是同一个版本序列。每份报告中的来源提交和冻结条件决定其适用范围。

| 日期 / 阶段                    | 文档                                                                           | 职责与阅读限制                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 09-21，工具探针及三题 pilot    | [coding-observations-pilot](2026-09-21-coding-observations-pilot.md)           | 固定输入字节测量、官方 DeepSeek 小样本和目录去重的早期回退；不代表最终组合候选 |
| 09-21，ARM 主机上的 amd64 尝试 | [local24-tool-efficiency](2026-09-21-local24-tool-efficiency.md)               | 默认 JIT 与 JITless 停滞、未完成配对及全部尝试成本                             |
| 09-21，Boyue release 筛查      | [boyue-coding-observations](2026-09-21-boyue-coding-observations.md)           | 三题两侧、独立委派、请求关联缺口与扩样拒绝                                     |
| 09-22，免费基础设施审计        | [local24-infrastructure-audit](2026-09-22-local24-infrastructure-audit.md)     | HOME、请求身份、调度、清理与原题依赖问题；不新增模型成绩                       |
| 09-22，前瞻协议                | [local24-v6-protocol](2026-09-22-local24-v6-protocol.md)                       | V7 执行的预先规则，以及 Cython/Stan 的 v6 依赖变体                             |
| 09-22，准备清单                | [local24-v7-readiness](2026-09-22-local24-v7-readiness.md)                     | 免费准备通过的范围；不是正式实验完成证明                                       |
| 09-22，V7 终态                 | [local24-v7-stopped-study](2026-09-22-local24-v7-stopped-study.md)             | 第 22 个付费预检清理失败，48 个正式单元均未启动                                |
| 09-23，V9 + V10                | [local24-glm-paired-study](2026-09-23-local24-glm-paired-study.md)             | 48 个原始单元加 21 个网络启动失败补充，保留 69 次尝试；附 JSON、CSV            |
| 09-23，独立离线重判            | [boa-dependency-regrade](2026-09-23-boa-dependency-regrade.md)                 | 原补丁补齐依赖后的真实测试，零新模型调用；附 JSON，不替换原评分                |
| 09-23，V11 故障修复            | [local24-glm-fault-repair-study](2026-09-23-local24-glm-fault-repair-study.md) | 新增七个预选单元，形成 76 次尝试与 24 对来源选择视图；附 JSON、CSV             |
| 09-24，等待提示                | [process-waiting-study](2026-09-24-process-waiting-study.md)                   | CompCert/Mailman 两项新结果及两项模型前失败；附 JSON、CSV                      |
| 09-24，离线诊断                | [process-waiting-followup](2026-09-24-process-waiting-followup.md)             | 输入等待、错误退出码、固定工具定义和缓存诊断；附 JSON，不新增执行              |
| 09-24，通用提示与去重          | [general-guidance-study](2026-09-24-general-guidance-study.md)                 | 两题定向验证，保留历史观察；附 JSON、CSV                                       |
| 09-24，全量候选覆盖            | [local24-candidate-study](2026-09-24-local24-candidate-study.md)               | 一次新候选 24 题，复用事先锁定的 24 条历史基线；附 48 行 CSV 与完整 JSON       |
| 09-28，合并版本分析            | [pr1475-optimization-analysis](2026-09-28-pr1475-optimization-analysis.md)     | 汇总改进机制、核算既有数据，并区分实验候选与最终 PR                            |

V8 的取消成本及 GLM 诊断作为封存历史出现在后续报告中，本目录没有独立的完整 V8 配对报告，不能用后续表格补造该轮成绩。

## 解释这些文件时必须保留的区别

- 每份历史报告的 Draft、拒绝或停止结论属于该次冻结观察；PR 后续合并不把历史失败变成通过。反过来，旧报告中的 Draft 也不表示 PR 至今未合并。
- MD 解释范围与结论，JSON 保存更细的结构化证据，CSV 是该报告声明人口的表格导出。不同报告可能重复引用同一历史观察，不能把行数或 family totals 直接相加。
- 原生 reward、实际测试启动、执行是否结束、归档可读、archive receipt、recording 完整性和 usage 完整性分别判断。
- 字节不是 token；总 token 不是账单；单题时长之和不是并行批次历时；未知字段不是零。
- 原报告及 26 个既有报告/数据文件保持不变。本文和优化分析提供入口与解释，不修改数据格式、历史选择规则或原始分数。

当前实现的权威入口是 [文件操作架构](../../architecture/workspace-and-files.md)、[LLM 循环](../../architecture/llm-loop.md)、[benchmark 说明](../../../benchmark/README.md)、[工具观察决策](../../decisions/implemented/architecture/2026-09-21-bounded-coding-tool-observations.md)、[工具说明单一归属](../../decisions/implemented/simplification/2026-09-24-single-owner-tool-guidance.md)和 [Docker 资源准入](../../decisions/implemented/architecture/2026-09-27-benchmark-docker-resource-admission.md)。
