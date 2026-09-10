# Local benchmark cancellation lost export evidence

## Executive summary

首次真实长任务在官方时限内超时后，取消路径关闭了仍在接收数据的 artifact，导致记录失败。评测包装器又把导出限制在收尾预算的一小部分，且未保存 exporter 退出状态。短流集成测试只验证了正常完成，遗漏了取消与持久化同时发生的情形。任务得分、执行终态和证据可靠性必须独立验收。

## Summary

两个正式原题样本分别得到失败和成功评分。失败样本保留了大部分 Home、计量和 verifier 结果，但缺少最终 rollout ZIP；成功样本的 ZIP 可以校验。两者还暴露了 Linux watcher 的 EINTR 错误，以及资源销毁时缺失 Scope 上下文。超时与答错本身是有效评测结果，不能通过重复采样或放宽原题时限消除。

## Timeline

- 2026-09-09：确定性短流通过 core、core-library、full 及共享/独立 verifier 的集成检查。
- 2026-09-10：真实运行暴露取消竞态、导出缺失、watcher 信号处理和 Scope 销毁问题。
- 2026-09-10：同步屏障测试复现关闭后写入；实际 Linux poll 信号注入使原始 binding 失败，修复后的 binding 继续收到文件事件。

## Root cause

Transport 取消没有等待已开始的读取与 chunk 持久化，body-end 因而可以先于 chunk。Recorder 并发 finish 未共用完成 Promise，call 的写入等待也没有覆盖 checkpoint。State 保存的销毁回调没有绑定创建上下文。Parcel Linux backend 把 poll 返回 EINTR 当作永久失败。

包装器复用 cleanup 预算限制 exporter，却只使用 agent 退出码表达最终状态。恢复流程先清理环境、后检查终态证据，且只对部分调度状态进行修复。同步哈希扫描会阻塞其他 trial；凭据通过 Docker exec 环境参数进入进程 argv。短流、无取消的成功样本不能发现这些跨阶段问题。

## Guardrails added

[取消与上下文决策](../decisions/implemented/bug-fix/2026-09-10-rollout-cancellation-drain.md)定义已接收写入的排空顺序。[评测决策](../decisions/implemented/testing/2026-09-09-local-benchmark-evidence.md)规定独立导出期限、版本化结果、离线模型身份、凭据文件和恢复证据。完整归档校验复用产品 `RolloutArchive.inspect()`，不通过忽略关闭后写入或减少校验来处理竞态。

[长流测试](../../packages/harness/test/session/rollout-long.test.ts)使用 30 MiB 响应和 30,720 次 checkpoint，验证字节、usage、引用和 ZIP；[取消屏障](../../packages/harness/test/session/rollout-transport.test.ts)覆盖读取与写入并发；[原生信号测试](../../benchmark/test/test_native.py)验证实际编译的 Linux binding。原失败 Home 的恢复导出写入独立副本，原始失败和评分保留。

## Lessons

基准题答对不能证明评测链路可靠。成功、正常失败、主动取消、基础设施失败和记录失败应使用不同证据判定；未知计量保留未知。原生依赖的源码补丁只有进入并通过实际二进制测试，才改变运行结果。真实实验的失败样本是需要保留的证据。

## Follow-up findings

扩大同步屏障到 2 MiB 单次上游数据后，复现了 abort 导致 `reader.cancel()` 拒绝并跳过已接收尾部的问题；关闭现在独立排空已接收尾部。独立 verifier 的真实容器测试还发现 Pier 0.3.1 把容器删除纳入评分超时，已产生的评分因收尾超时被覆盖。评测生命周期将该清理移到独立期限，保留原评分时限，并取消自动重跑评分。原生进程退出后的 Docker 所有权审计会标记并清理残留资源，清理故障不能覆盖已有评分。

断流容器测试进一步发现，操作系统信号进入 CLI 时没有保留 Scope 上下文，取消期间读取 history 失败，导致缺少终态 accounting。SIGTERM、SIGINT 的真实子进程回归均先复现失败；信号入口绑定注册时的上下文后，取消继续保存原生终态与未知 usage。

Linux 所有权审查发现，adapter 在 Pier 交接日志之前读取容器创建的私有 accounting；Docker Desktop 的所有权映射掩盖了这个顺序错误。行为测试先复现 PermissionError，再将读取移到 Pier 日志交接后的 hook。运行中的故障注入探针在已验证的所属容器内读取记录，不扩大文件权限。
