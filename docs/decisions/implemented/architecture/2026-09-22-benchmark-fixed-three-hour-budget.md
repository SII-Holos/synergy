# Decision Record: One fixed three-hour benchmark execution budget

Status: implemented

## Problem

解题默认三小时仍允许预设选择原题期限，判题和 oracle 又分别读取任务自身的短期限。同一个评测入口因此有不同的截止来源；仅检查默认配置无法证明模型、参考解和判题器都获得声明的运行时间。

## Decision

[配置模块](../../../../benchmark/src/synergy_bench/config.py)中的 `TASK_TIMEOUT_SECONDS = 10800` 是正式解题、oracle 参考解执行和判题的唯一预算来源，每个执行阶段分别有三小时上限。实验配置删除题目期限字段，题目清单删除逐题 agent/verifier 期限；严格解析拒绝这些旧字段及任何数字覆盖。预设、CLI 和旧配置显式迁移都不能重新启用其他时限。

[模型启动器](../../../../benchmark/src/synergy_bench/runner.py)和 [oracle 启动器](../../../../benchmark/src/synergy_bench/oracle.py)都向 Pier 显式传递固定预算。模型解题从首个真实请求开始计时，外层进程及 Synergy CLI 的期限包括启动、导出和清理余量；这些余量不增加模型解题时间。预检、准备、连接和清理仍属于独立基础设施阶段，不能通过嵌套命令的默认期限截断正式执行。

冻结计划的 `task_timeout_seconds` 记录唯一预算并进入[报告配对条件](../../../../benchmark/src/synergy_bench/report.py)。历史记录缺少该条件时保持未知，不填入新的常量，不改写旧失败或重新派发。原始上游任务文件保持完整，但不参与新执行的期限选择。此策略替代已归档的[可选研究期限策略](../../archived/architecture/2026-09-21-benchmark-research-deadline-policy.md)。

[预设测试](../../../../benchmark/test/test_experiment_presets.py)自动发现全部 YAML，检查两种 Synergy 导出协议及各 harness 的实际启动预算。[原生控制](../../../../benchmark/test/test_oracle.py)检查 Pier 内部计时器，并在 Docker 中让参考解和判题器实际运行超过夹具声明的短期限。超时故障测试只在测试进程内注入短时钟或修改一次性 TrialConfig，生产配置没有测试期限开关。

## Alternatives considered

**保留三小时默认值和原题模式。** 显式旧选项仍可绕开默认值，正是此次遗漏的来源。

**只移除现有 YAML 的短期限。** 新预设或程序调用仍能恢复旧行为，不能保证单一执行逻辑。

**只统一解题时限。** 参考解或判题仍可能在三十分钟提前结束，实验依然受另一条期限路径影响。

## Consequences

新执行只能使用固定三小时预算。带有旧期限字段的输入必须移除字段后再准备新实验；不提供自动兼容分支。解题和判题分别计时，完整生命周期还包含独立准备与归档阶段。三小时条件下的结果不能宣称为官方原题时限成绩。历史原始证据、失败和费用完整保留，测试时钟注入不用于研究执行。
