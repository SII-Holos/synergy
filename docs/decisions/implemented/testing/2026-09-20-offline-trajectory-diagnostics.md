# Decision Record: 保留证据的离线轨迹诊断

Status: implemented

## Problem

正式 benchmark 报告回答评分、用量完整性和配对比较问题，但定位执行速度与额度开销还需要逐请求、上下文、工具回传和子会话证据。混合预检与正式任务的延迟、把缓存和 reasoning 额外累加、把重复文本等同于无效步骤，都会误导优化判断。修改冻结评测器或重跑旧题也会改变待解释的实验。

## Decision

新增只读的 [`synergy_bench.trajectory`](../../../../benchmark/src/synergy_bench/trajectory.py) 模块，接受既有运行目录，向证据树之外导出不含正文的 JSON／CSV。它读取 Chat Completions wire 与公开 Synergy rollout v1，复用既有 usage 归一化和摘要算法，保留每次派发、原始 reward、用途、子会话和完整性状态，不参与评分选择或运行调度。

token 使用服务商记录；历史内容、工具 schema 和回传的重复暴露使用 UTF-8 字节。并行耗时计算区间并集。摘要重复的 wire 与 native 请求只有在数量一致时才按时间关联，并标记 `ordered_duplicate`；无法唯一确认的关联不伪装成请求 ID 证据。缺失元数据报错，缺失 native 对应 wire 或非终态证据不产生精确总量。正文检查与套餐额度测算留在私有研究产物中；无账户扣减证据时不输出实际订阅消耗。

## Alternatives considered

**扩展正式评分报告。** 轨迹诊断需要读取完整请求和归档，而评分报告需要较轻量、稳定的聚合。独立模块保留二者各自的运行成本与证据边界。

**只写一次性脚本。** 一次性脚本难以持续验证重试、缺失 usage、区间重叠和敏感正文导出等易错情况；共用解析器与临时证据行为测试使后续实验采用相同口径。

**按字节比例分摊实际 token 或推断节省。** tokenizer、协议框架与缓存归属无法由 UTF-8 长度精确恢复；重复历史也可能是完成任务的必要条件，因此保留字节测量及描述性信号。

## Consequences

研究者可以逐题追溯开销来源而不更改旧证据，也能分别观察评分失败、工具失败和数据缺失。模块暂时只支持明确列出的协议与归档版本；不自动推断其他 harness 的正文格式，不重建缺失的 provider usage，不输出优化效果或因果结论。导出仍包含研究元数据，访问范围沿用原始证据。用法与字段口径位于 [benchmark 文档](../../../../benchmark/README.md#离线轨迹诊断)，行为验证位于 [测试](../../../../benchmark/test/test_trajectory.py)。
