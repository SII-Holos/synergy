# Archive 的运行时收尾延迟被计入长会话清理

## Executive summary

30 MiB 长流验证的清理阶段耗时数分钟，但主要等待并不发生在删除 SQL。Bun 1.3.14 上，大量内存 ZIP 条目连续写入、读取后，运行时工作积压到下一次 I/O；该 I/O 恰好是删除前的会话读取。原有测试验证字节完整性和最终清理结果，却没有验证事件循环在 archive 处理中能持续推进。分阶段计时、独立 ZIP 复现和响应性回归揭示了这个归因错误；archive 每处理有限数量条目后交还事件循环，保留全部完整性检查。

## Summary

同一长流测试写入 30,720 个 checkpoint，验证原始字节、accounting、archive，再调用真实 `Session.remove`。实现集合删除后，completed 本地样本的 `Session.remove` 仍约 170 秒，其中存储树删除约 0.47 秒。进一步计时把长等待定位到删除前第一次 `Session.get`，不能据此认为会话读取本身需要扫描这些 archive 字节。

本地独立复现仅使用 ZIP 库和 30,720 个 1 KiB 条目，不启动 Session、Runtime 或数据库。写入约 3.58 秒、读取累计约 5.49 秒结束，第一次事件循环返回却到约 203.31 秒。原生采样集中在主线程 `memmove`；这支持“运行时工作在后续 I/O 边界集中执行”的归因，但没有证明某个上游内部算法存在特定缺陷。

## Timeline

- 2026-09-23：CI 调查观察到长流清理占据显著时间，尚不能细分 SQL、snapshot、workspace 和运行时成本。
- 2026-09-24：加入真实阶段计时，集合删除通过存储回归；删除阶段仍出现约 170 秒长尾。
- 同日：独立 ZIP 复现排除数据库与会话；响应性回归在改动前观测到计时器零次推进。
- 同日：写入、读取每 128 个条目执行一次 `setImmediate` 后，相同独立复现约 5.80 秒完成，响应性回归通过。

## Root cause

连续的 Promise/stream 操作可以完成逻辑处理，却不足以保证外部事件循环及时处理所有运行时工作。原测试只在相邻业务步骤之间计时，便把滞后成本计入下一步。它验证“最终字节正确”和“最终删除成功”，没有覆盖大量 archive 条目下的调度响应性。若只继续优化 SQL，或者跳过真实清理，就会保留主要停顿并掩盖成本来源。

## Guardrails added

- [Archive](../../packages/harness/src/session/rollout/archive.ts) 限制两次事件循环交接之间的条目数；CRC、摘要、引用边界及原始字节校验保持完整。实现选择见 [CI 决策](../decisions/implemented/testing/2026-09-24-ci-verification-plans.md)。
- [响应性回归](../../packages/harness/test/session/rollout-archive.test.ts) 验证处理 archive 时计时器可以推进，并保留损坏与导入验证；不以易抖动的毫秒阈值作为正确性门槛。
- [长流回归](../../packages/harness/test/session/rollout-long.test.ts) 保留 completed、cancelled、failed 的 30 MiB / 30,720 checkpoint，记录持久化、archive、会话与存储删除、snapshot/workspace 释放及 Runtime 退出。
- [测试指南](../../.synergy/skill/testing-guide/SKILL.md) 要求测量大规模内存 stream/archive 循环后的第一次 I/O，避免再次误归因。

本地修复后的三个完整场景分别约 87.49、92.16、96.12 秒，总计 276.49 秒；completed 清理约 0.71 秒。它们与托管 runner 的负载、OS 和缓存条件不同，不作为 CI 端到端性能达标证据。

## Lessons

阶段计时记录的是成本被观察到的位置，不自动证明成本产生的位置。对大量 Promise 或内存 stream 操作，应同时观察事件循环响应性和后续第一次 I/O，并通过独立复现排除相邻系统。保留原测试规模、原始字节验证与真实释放路径，才能确认优化消除了工作积压。
