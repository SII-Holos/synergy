# Decision Record: 以任务计划和执行证据组织 CI

Status: implemented

## Problem

包测试、coverage、类型与发布检查分别维护执行列表，导致同一测试集合重复运行、构建重复准备和任务同时抢占 runner。PostgreSQL 三版本任务没有接入 required check。Benchmark 的 source/runtime/bin/bundle 校验重复读取相同字节；整棵会话树删除反复递归搜索已经清空的节点。

## Decision

使用统一任务目录自动发现 workspace 与测试，按 base/head 两侧依赖闭包生成计划。任务结果绑定计划摘要、测试提交、run、attempt 和模式，并附带可校验的 JUnit、lcov、逐文件批次清单及耗时。required check 保留 `All checks passed`，核对实际 job 与计划完成性。CI 的类型与 package check 各运行一次；覆盖率和普通测试合并执行，特殊平台与非插桩验证独立保留。

工作流使用标准托管 runner 和有界矩阵。验证后的 watcher、plugin、sandbox helper 产物按输入身份复用；完整列表、字节摘要与权限校验通过后才恢复。Benchmark 正常路径与故障恢复共享只读准备产物，外部 harness 不安装 Synergy workspace。跨 run 不缓存成功结论，冷全量每日执行。

构建缓存键在实际构建 runner 上计算，包含镜像及 Rust/C 工具链身份。跨 job 恢复另以源码、Bun、OS/架构和 libc ABI 校验兼容性；托管镜像滚动更新可能让同一工作流使用不同镜像版本，不能把消费端镜像版本等同于构建输入。完整字节和权限核验保持不变。

任务目录声明浏览器、Desktop 和 sandbox 前置环境；包级浏览器需求从其 Playwright 依赖自动发现，调度器只合并这些声明。已验证的 sandbox helper 暂存到既有 Cargo 产物发现路径，再由源码 Runtime 安装到各自独立 Home，避免依赖 runner 默认 Home 的隐式共享状态。

影响分析以 shadow 模式交付，20 个覆盖主要变更类型的完整样本和零漏选失败是 affected 的程序化准入条件。主线始终全量，诊断执行不能提供合并绿灯。性能目标与测量口径见 [CI 验证](../../../operations/ci.md)，本决策不表示托管性能验收已完成。

Benchmark 采用单次操作内的完整字节 inventory 派生多种摘要；每次外部 prepare/resume 重新读取内容，保留原摘要格式与 evaluator 冻结约束。会话树删除先保留 record tombstone、revision 和 artifact GC，再通过 materialized recursive CTE 一次删除已清空的派生节点，只沿祖先链检查共享节点。持久化格式不变，单记录/批次删除保持原来的精确清理方式。

Archive 写入和读取每 128 个条目交还一次事件循环，限制连续 Promise/stream 工作积压；每个字节、CRC、摘要和引用边界仍须验证。采用有限工作批次而非固定睡眠，以保留吞吐并允许计时器和其他请求推进。归因过程与本地测量见 [长流清理复盘](../../../postmortem/0027-archive-work-delayed-rollout-cleanup.md)；局部观测不替代托管性能验收。

调度依据 [GitHub matrix max-parallel](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations)，缓存依据 [GitHub cache scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)。跨 job 产物另附字节清单；Bun 测试退出码和本次 lcov 仍是必需证据。

## Alternatives considered

**只增加并发或购买 runner。** 可缩短某个 job 的表面等待，但不消除重复测试、准备和校验成本，也会扩大共享容量争用。

**仅依据路径跳过工作流。** 删除、动态资源和测试依赖可能漏选；缺报或跳过的 job 也不能证明计划完成。两侧依赖图、未知输入全量与报告核验提供可测试的保守路径。

**复用历史覆盖率或目录 mtime。** 不能证明本次完整测试和内容完整性，因而不用于准入或 benchmark 恢复。

**立即打开 PR 选测。** 本地选择器测试不能替代真实全量对照，故默认 shadow，并把切换条件写入准入器。

## Consequences

日常失败可以按任务、包或文件复现，完整门槛能识别漏任务、错误提交与陈旧报告。集合删除的节点操作次数取决于祖先深度而非子树宽度/深度；字节 inventory 避免重复内容读取。真实 PostgreSQL、回滚、共享 artifact、延迟写入及大子树回归保留。

任务目录、输入依赖和报告格式成为需要共同维护的测试基础设施。保守全量与 shadow 阶段仍有完整成本；缓存打包、传输、并发上限也会影响关键路径。必须用托管全量样本确认收益与非确定性失败，不能从局部耗时外推最终 CI 达标。
