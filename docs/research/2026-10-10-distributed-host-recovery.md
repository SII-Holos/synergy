# 多设备 Host 与任务恢复实现调查

本文保存实现证据和研究边界，不代表已支持的产品行为。研究日期：2026-10-10；基线：`dev` 的 `9c3b2323c`。第一版范围收敛为暂停 Session 的手动迁移；当前方案、交接协议、影响面和验收条件统一保存在[手动跨 Host 迁移决策](../decisions/implemented/architecture/2026-10-10-distributed-host-runtime.md)。自动分布式恢复保留为后续方向。

## 研究问题与范围

原研究问题是可信个人设备之间的自动任务放置与故障续跑，以及如何避免同任务分叉和重复计算。第一版问题收敛为：两端在线时，用户选择目标 Host，迁移暂停 Session 的完整恢复输入并有序交接执行权。手动迁移不需要固定 Coordinator 或持续多数派，也不承诺源设备突发永久丢失后的自动接管；已完成历史模型和工具结果仍需复用。

调查覆盖 Runtime/Storage 所有权、Session 与 Rollout 恢复、Environment 执行回执、Workspace 对象传输、Agent worker、客户端同步和原生设备能力。本文以源码、schema、现有测试和架构说明交叉确认，不包含真实多设备故障实验。

## 实现证据

| 已有能力或限制                                                                                   | 实现与测试                                                                                                                                                                                                                      | 对方案的含义                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Agent Runtime 显式组合组件，Harness 拥有生命周期和持久化                                         | [Runtime 入口](../../packages/agent-runtime/src/index.ts)、[架构概览](../architecture/README.md)                                                                                                                                | 可以新增 Peer 组合层，保留一套 Session、权限和恢复语义                   |
| Environment 独立于 Session/Scope/Workspace，已有远程 Executor                                    | [Environments](../architecture/environments.md)、[Execution Host](../../packages/local-runtime/src/environment/host.ts)、[RemoteExecutor](../../packages/local-runtime/src/environment/remote-executor.ts)                      | 远程 shell、文件和输出传输不需要重新设计                                 |
| 执行意图先持久化；重复 operation ID 查询旧结果；丢失回执进入 unknown                             | [EnvironmentExecution](../../packages/harness/src/environment/execution.ts)、[执行测试](../../packages/harness/test/environment/execution.test.ts)                                                                              | 接管必须查询既有操作，保存失败只重试保存                                 |
| Workspace 有 hostID、binding generation、mount generation 和内容 manifest                        | [WorkspaceCatalog](../../packages/harness/src/workspace/catalog.ts)、[挂载与保存](../../packages/harness/src/workspace/mount.ts)、[WorkspaceTree](../../packages/harness/src/workspace/tree.ts)                                 | 身份和物理路径已分离；对象 Workspace 有可复用的传输基础                  |
| 普通目录和 volume 保存只确认本机文件，不发布对象 manifest                                        | [WorkspaceMounts.save](../../packages/harness/src/workspace/mount.ts)、[Workspace 文档](../architecture/workspace-and-files.md)                                                                                                 | 默认 native Workspace 不能因为已有 checkpoint 就被认为已复制到其他设备   |
| Rollout journal 可以 fold 成执行记录；恢复不会重跑工具                                           | [RolloutSnapshot](../../packages/harness/src/session/rollout/snapshot.ts)、[RolloutRecovery](../../packages/harness/src/session/rollout/recovery.ts)、[恢复测试](../../packages/harness/test/session/rollout-recovery.test.ts)  | trace 的现有 replay 是记录重建，不是可恢复的 JavaScript 调用栈           |
| Session loop lease 是 Runtime 内存中的 generation；宿主可以控制入口授权                          | [SessionManager](../../packages/harness/src/session/manager.ts)、[SessionExecutionSource](../../packages/harness/src/session/execution-source.ts)、[入口授权测试](../../packages/harness/test/session/execution-source.test.ts) | 可以接入放置授权，但还缺持久租约、续租及贯穿执行生命周期的跨设备 fencing |
| 一个 Runtime 独占一个 Storage namespace；PG 不支持同 namespace 自动 failover 或多 Runtime 同时写 | [Agent Storage](../architecture/agent-storage.md)、[PostgresDriver](../../packages/harness/src/storage/postgres-driver.ts)                                                                                                      | 换成 PG 并不能直接得到分布式 runtime；第一版应保留 namespace 单写者      |
| Agent artifacts 是目录中的 append-only packs；文件历史还有独立的 Git 对象存储                    | [Storage](../../packages/harness/src/storage/storage.ts)、[Agent Storage](../architecture/agent-storage.md)                                                                                                                     | 远程 SQL 不是完整的数据远程化，还需要可恢复的 artifacts、附件和快照对象  |
| Agent workers 使用本地 Bun 子进程与 IPC，且不拥有 Session 写入                                   | [process-host](../../packages/harness/src/session/agent-turn/process-host.ts)、[执行边界](../architecture/execution-boundaries.md)                                                                                              | 远程 Agent worker 与远程 Executor 是两项独立工作                         |
| 普通交互会话启动恢复后暂停，等待 Continue；不会因重启自动跑                                      | [Session 恢复语义](../architecture/session-and-messages.md)、[SessionInvoke](../../packages/harness/src/session/invoke.ts)                                                                                                      | 自动设备接管需要显式任务策略，必须保持用户 Abort/Abandon 的含义          |
| Browser 属于 Desktop-local，native broker 只接受 loopback，页面/登录身份有独立所有权             | [Browser runtime](../architecture/browser-runtime.md)                                                                                                                                                                           | 第一版不把 Browser 页面、登录态当作 Workspace 文件迁移                   |

上述测试已阅读，未在本任务运行。安装版 CLI 的 `--help` 在配置加载处返回 `ConfigInvalidError`，因此未从该实例确认命令面；没有修改配置或重启现有实例。

## 相邻域证据与不确定性

[RolloutCall](../../packages/harness/src/session/rollout/call.ts) 记录模型调用意图、请求与响应证据，并保存流 checkpoint；它没有通用的跨设备模型 job handle 查询协议。确认前缀可以成为事实证据，但不能恢复模型服务内部随机状态，也不能把不完整工具调用当作完整结果。

[EnvironmentExecution](../../packages/harness/src/environment/execution.ts) 在 intent、执行、输出 drainage、checkpoint 保存和资源 release 之间保持持久状态；执行测试验证响应丢失后查询原操作、保存失败不重跑和 endpoint 变化后的对账。allocation generation 防止访问旧分配，但还不是跨 Runtime owner 授权。

[Workspace catalog 测试](../../packages/harness/test/workspace/catalog.test.ts) 验证 host/binding generation、内容发布与未绑定导入；[原生对象树测试](../../packages/local-runtime/test/workspace/tree.test.ts) 覆盖分块二进制、目录、权限、symlink、源路径消失后的恢复及损坏 chunk 拒绝。[Environment lifecycle 测试](../../packages/harness/test/environment/lifecycle.test.ts) 保留未知 allocation 和丢失 Workspace view 的 unavailable 语义，不隐式创建替代资源。Git worktree relocation、跨平台恢复及运行中多 writer 捕获还需要新实验。

[Cortex](../architecture/cortex.md) 的子 Session、结果投递与任务树，[Workflows](../architecture/workflows.md) 的持久 driver，以及[Channels](../architecture/channels.md)的接收/投递，具有独立生命周期。复制根 Session 不构成这些工作完成后的组级接管；需要保持 stable delivery identity、取消、并发和费用预算。

[Frontend data sync](../architecture/frontend-data-sync.md) 已有 event epoch/seq 和 snapshot generation 的重同步语义，但没有 Fleet owner 路由协议。[Execution boundaries](../architecture/execution-boundaries.md) 的权限与资源绑定不能因目标 Host 改变被绕过；[Browser runtime](../architecture/browser-runtime.md) 属于 Desktop-native，Workspace 文件不包含页面与登录身份。

## 手动迁移的实现证据

[SessionLifecycle](../../packages/harness/src/session/lifecycle.ts) 拥有暂停 latch，区分用户暂停与机器/工作流驱动；[Session 暂停与 Abort](../architecture/session-and-messages.md#recovery) 在记录暂停后中止执行并修复工具。界面暂停不能证明物理过程和文件已经排空。[EnvironmentExecution.complete](../../packages/harness/src/environment/execution.ts) 要求 terminal status 与 streams 完成，保存输出/checkpoint 后才释放资源，手动迁移应沿用这些核验。

[SessionExport](../../packages/harness/src/session/session-export.ts) 导出 info、messages、DAG、Todo、diffs 与 Workspace 元数据，compact/standard 会截断工具内容；full 不截断，但仍不覆盖完整 Rollout、Inbox、执行回执和二进制对象闭包。[StoragePortable](../../packages/harness/src/storage/portable.ts) 以逻辑 record/revision/artifact/receipt/event 表达数据，当前 exportFile 捕获全 store；按 Session 拥有者过滤和完整迁移包需要新增机制。

[SessionExecutionSource](../../packages/harness/src/session/execution-source.ts) 可以阻断 loop admission，但不自动冻结输入、配置与全部公开写入口。[WorkspaceTransfer](../../packages/harness/src/session/workspace-transfer.ts) 已识别消息/附件/diff 等结构化 Workspace 引用，[ScopeTransfer](../../packages/harness/src/scope/transfer.ts) 提供路径 relocation；这些是目标资源映射的基础，不代表跨 Host 所有权交接已实现。跨 home Portable 导入不会携带 permissions/plugin trust 等授权记录。

本任务只阅读代码和测试，没有执行暂停迁移、双端 commit 或故障注入实验。

## 对象存储的空间与传输基线

[WorkspaceTree](../../packages/harness/src/workspace/tree.ts) 使用 SHA-256 身份和固定 4 MiB 最大块，manifest 包含文件 hash、chunk 引用、目录、模式和 symlink。相同内容可复用对象键，但固定分块不等于内容定义分块；文件头插入可能改变后续许多块。

[NativeWorkspaceTree.capture](../../packages/local-runtime/src/workspace/tree.ts) 遍历完整目录、读取文件并对每个块调用 `store.put`，同时核验捕获期间的物理版本。它没有过滤可重建目录或查询目标缺块的协议，也没有自动避免对未变化文件的完整扫描。[BlobStore](../../packages/harness/src/workspace/content.ts) 的接口只有 put/get；[S3/OSS adapter](../../packages/local-runtime/src/workspace/blob-store.ts) 使用 prefix/hash 对象键，但 put 仍上传字节。跨设备增量同步、压缩、共享对象池配额和恢复引用 GC 需要新机制，不能由内容 hash 推断已实现。

[Workspace archive](../../packages/harness/src/workspace/archive.ts) 按 hash 收集不重复 chunk，已有归档去重基础。Native materialize 读取并校验对象后写入目标文件，产生独立目录；它没有文件系统 copy-on-write 的零复制保证。新增跨设备方案的存储测量应分别统计持久对象、执行视图、缓存、历史引用、首次复制、每步新块与完整扫描成本。

第一版选择[按需迁移](../architecture/session-transfer.md#persistence-and-storage-lifecycle)，复杂增量副本、缓存分类与长期 GC 延后。没有在本任务运行真实容量、增量传输或大量 checkpoint 去重实验。

## 外部原理来源

| 来源                                                                                                                                                                                    | 对本调查的约束                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Raft 论文](https://raft.github.io/raft.pdf)、[etcd FAQ](https://etcd.io/docs/v3.5/faq/)                                                                                                | 多数派提交与 leader 选举可以复制协调权威；节点失联不等于旧物理执行已经终止                     |
| [Temporal Workflow Definition](https://docs.temporal.io/workflow-definition)、[Tasks](https://docs.temporal.io/tasks)                                                                   | 确定性 workflow replay 复用历史活动结果，不能理解为重新计算所有历史活动                        |
| [Temporal Activities](https://docs.temporal.io/activities)、[Activity Execution](https://docs.temporal.io/activity-execution)                                                           | 活动重试与 checkpoint 是分别设计的机制；durable execution 本身不提供零重算                     |
| [AWS 幂等 API 设计](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)                                                                                  | 安全重试需要接收端理解稳定语义操作身份；本机去重不能排除未知外部效果                           |
| [Bitcoin 论文](https://bitcoin.org/bitcoin.pdf)                                                                                                                                         | PoW 用累计工作量选择历史，允许临时分叉；这一计算与确认方式不满足 agent 费用约束                |
| [Ethereum PoS](https://ethereum.org/developers/docs/consensus-mechanisms/pos/)、[Attack and defense](https://ethereum.org/developers/docs/consensus-mechanisms/pos/attack-and-defense/) | 共识投票和交易确定性重执行不等于任意模型、shell 与外部 API 可重复执行；不足投票会影响 finality |

这些来源用于原理对照，没有在 Synergy 中集成对应实现。本调查也没有测量共识延迟、对象复制吞吐、断电持久性、provider 结果查询覆盖、接管 RTO 或重算成本。

## 处置

调查结论进入[手动跨 Host 迁移决策](../decisions/implemented/architecture/2026-10-10-distributed-host-runtime.md)，本文件保留基线证据、自动恢复原理与不确定性。没有修改 runtime、API、schema、CLI、配置或现有恢复行为。实现后由对应域更新当前架构说明和测试，再转换提案生命周期；不能将源码阅读或模型自述视为故障验收完成。
