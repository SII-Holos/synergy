# Short native probes missed OpenCode runtime stalls under Rosetta

## Executive summary

OpenCode 的短工具往返预检通过后，真实长任务仍在内嵌 Bun 1.3.14 / Rosetta 运行路径中停滞。独立复现移除了 benchmark 采集器并使用容器本地 Home，仍观察到相同的线程锁等待和被屏蔽的挂起信号。默认 JIT 的一次长会话成功也未排除间歇性故障。修正方向是显式使用已验收的解释执行变体、重复验证原生长会话，并将人工取消从配对差值中排除；上游内部缺陷尚未修复。

## Summary

故障发生在 OpenCode 1.15.13 执行 Linux amd64 任务的 Apple Silicon 宿主上。进程的模型请求和上一工具已经完成，下一请求在本地元数据原子发布之前停住。仅凭最后一个日志位置，容易误判为采集器或 fsync 故障。

四次移除采集器的默认 JIT 控制中，一次完成 120 次工具调用，其余三次分别在 64、41、111 次后停滞；容器本地及宿主挂载 Home 均复现。三次都出现主线程 futex 等待、其他线程 PI futex 等待，以及编译线程停在 sigsuspend、SIGTRAP 挂起但被屏蔽的组合。诊断停止前保存了现场，Docker 未报告 OOM。两个关闭 JIT 的控制分别在裸 CLI 和带采集器环境完成全部 120 次工具调用；更早的两个同类控制和两道真实模型任务也通过。

同样的请求体写入、fsync、关闭和重命名序列，在 Node、内嵌 Bun 默认 JIT、关闭 JIT 三组各完成 500 次。简化的 Wasm 编译与热循环也未复现。通过这些控制不能排除所有文件系统或 JIT 缺陷，但采集器及可写宿主 Home 挂载都不是此类停滞发生的必要条件。

## Timeline

- 原生预检完成工具往返；真实长任务随后失去进展。
- 现场确认 provider 响应和上一工具已经完成；连续快照中的线程 CPU 计数、等待位置和请求文件完全不变。
- 裸 CLI、本地 Home 和重复 JIT 控制复现相同故障，排除了只根据最后写盘位置归因的判断。
- 经用户授权结束已确认停滞的尝试，保留原生判题、消耗和归档，并为后续实验提供独立的长会话配置。

## Root cause

能够确认的是可重复触发的 Bun / Rosetta 编译线程及信号处理停滞；尚未解析具体锁所有者或最初触发指令，不能断言某一个内部函数已经确定为根因。实际内嵌 WebKit revision 为 `5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b`；该版本的 [Wasm helper 实现](https://github.com/oven-sh/WebKit/blob/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/JavaScriptCore/wasm/WasmWorklist.cpp) 和 [JIT 选项定义](https://github.com/oven-sh/WebKit/blob/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/JavaScriptCore/runtime/OptionsList.h) 用于解释运行时身份，不是同一上游缺陷已确诊的替代证据。

预检验证了连接和工具调用，覆盖不了长会话中的间歇性编译路径。纯传输压测也没有执行完整原生 CLI。测试平台和真实评测平台的 CPU 架构不同，短流程 CI 成功不能证明 Rosetta 下的长会话稳定。

## Guardrails added

- [长会话研究配置](../../benchmark/configs/glm53-long-session.yaml) 显式设置三小时解题期限及 `opencode-jitless`，保留原生 verifier；[启动参数测试](../../benchmark/test/test_experiment_presets.py) 覆盖五种 harness 的实际生成配置与外层期限。
- [报告回归](../../benchmark/test/test_report.py) 保留人工取消的首次评分和全部消耗，同时排除其配对差值；自然到达声明期限的超时仍按原条件处理。
- [benchmark 开发流程](../../.synergy/skill/develop-benchmark/SKILL.md) 要求重复长会话控制，并区分采集器、Home 存储和运行时因素。独立诊断的无进展期限不得变成正常模型解题的短时限。

解释执行是经过验收的规避方案，会改变 CPU、内存及延迟行为；相关取舍记录在[矩阵决策](../decisions/implemented/architecture/2026-09-14-benchmark-native-harness-matrix.md)。旧尝试和其消耗保留，不能通过切换运行时覆盖失败。

## Lessons

最后完成的日志标记只说明进程停在哪里，不说明是谁导致停滞。连接成功、完整流读取成功和原生 agent 长会话稳定是不同的验证目标。延长解题预算可以避免正常工作被截断，但不会修复运行时死锁；规避方案的通过也不能等同于上游缺陷已修复。
