# Preparation deadline truncated native benchmark execution

## Executive summary

一次真实 DeepSWE 验收在约 1800 秒时提前终止，原题允许 agent 执行 10800 秒。Docker 命令包装层把准备阶段的默认上限用于未显式指定命令期限的 agent exec；外层仍报告原生长时限，掩盖了实际截断点。短任务、短流和显式指定时限的 oracle 检查均未越过这个边界。每一层期限的传递关系都需要独立验证。

## Summary

OpenCode 的 fd 样本在约 1800.56 秒退出命令层，执行终态、导出记录和归档缺失。独立账本保留了 101 次请求，100 次正常结束调用均与原生记录核对，末次中断调用用量未知。原生 verifier 启动并保留 reward 0，但该样本不能解释为普通模型失败。原冻结实验停止继续派发，已运行尝试及其消耗只读保留，修复后的实验另行冻结。

## Timeline

- 2026-09-14：确定性原生接入、故障注入和 Linux 生命周期检查通过。
- 2026-09-14：真实长任务首次超过命令层默认 30 分钟边界，发现实际阶段时长与原生时限不符。
- 2026-09-14：缩放时间尺度的真实子进程回归复现提前超时；修复期限传递并补充显式期限及取消回收验证。

## Root cause

[命令包装层](../../benchmark/src/synergy_bench/environment.py)使用 `timeout_sec or 1800` 处理所有 Compose 命令，而 Pier 的 `exec(timeout_sec=None)` 表示由调用方管理期限。内部 `run_process` 因此先于外层原生 agent 时限抛出 TimeoutError，外层又将它描述为 AgentTimeoutError。Docker exec 客户端结束后，原生包装器没有机会完成正常的取消、导出与终态收集。

既有测试的 agent 执行均短于 1800 秒，长流测试覆盖持久化及取消但未穿过该 Docker 命令边界；40 分钟 oracle 显式传递了命令期限，也未走缺失期限的路径。检查日志必须比较实际耗时和各层期限，而不能仅依赖异常名称或声明的超时秒数。

## Guardrails added

[环境回归](../../benchmark/test/test_environment.py)通过原生环境接口和真实子进程缩放时间尺度，分别验证未指定期限的执行、显式长期限、显式短期限和准备默认期限。[进程回归](../../benchmark/test/test_process.py)验证继承调用方期限后，取消仍回收进程树并保留输出。[资源及生命周期决策](../decisions/implemented/architecture/2026-09-14-benchmark-resource-and-cache-ownership.md)和[维护 Skill](../../.synergy/skill/develop-benchmark/SKILL.md)规定准备期限不得成为 agent 的隐含上限。

后续本地预热两次在模型派发前失败，新的来源记录将第二次定位到冻结镜像标签查找。按记录的镜像 ID 可读取原有内容，标签查找一度返回缺失，之后恢复；未重建或修改镜像，Docker 查找异常的内部原因保持未知。首次失败没有来源记录，不能认定与第二次同因。阶段和预热报告现保留不含异常文本或局部变量的类型、来源位置及因果链；回归测试验证这些字段不会复制异常中的凭据值。父进程故障测试也会在评测器提前退出时立即失败，不再等完整派发期限。

## Lessons

通过题目或跑绿短链路不能证明长任务遵守原生时限。不同层的缺省参数可能改变实验条件，终态及归档缺失必须作为验收问题处理。评测器缺陷引起的新实验必须保留旧尝试、全部消耗和变更原因，不能通过选择更高得分消除原始失败。
