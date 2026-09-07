# Decision Record: Scope 共享文件快照对象库

Status: implemented

## Problem

每个会话独立保存相同项目基线会重复占用对象与文件系统分配空间；直接合并对象目录又会失去会话隔离和回收所需的完整历史根。

## Decision

文件历史按 Scope 共享 Git 对象与保留引用，按会话和工作区隔离可重建索引。保持树哈希、文件过滤和现有差异/恢复 API；会话拥有树引用是读取授权条件。每个历史树在发布给消息之前建立保留引用，不能用最新树、reflog 或当前可见消息替代全部历史根。

旧仓库由中央迁移登记后继续在单一解析边界使用。离线维护按对象清单去重导入，使用持久检查点和 pack 保护，在验证与引用发布完成后切换所有权、清理旧副本。无消息关联的对象保留独立引用；归属不明确的仓库保持原样。清理索引缓存和回收对象必须持有独占 Scope 租约，默认压缩不删除对象。

分叉和 JSON 导入先获得新会话引用，再发布历史消息。永久删除先登记可恢复作业，移除会话后释放引用；归档、聊天回退和消息压缩不释放引用。完整数据搬迁通过专用对象与引用合并生成独立仓库，不直接拼接 packed-refs。存在所有权后端或作业冲突时拒绝该数据合并，保留来源供后续处理。

## Alternatives considered

[Git 独立索引](https://git-scm.com/docs/git)支持复用不可变对象并分离工作状态。[Jujutsu 的保留引用](https://docs.jj-vcs.dev/latest/technical/architecture/#gitbackend)提供了独立于 commit 历史的对象保护先例。[restic 的写入次序与锁](https://restic.readthedocs.io/en/stable/100_references.html#read-and-write-ordering)支持先对象后发布、删除与回收分离的协议；它们不是 JSON 与 Git 的跨存储事务。

不采用分散引用的 alternates 池作为最终布局，因为 [GitLab 对象池](https://docs.gitlab.com/development/git_object_deduplication/)需要额外协调借用者与回收。不采用硬链接替换或降低快照频率，因为它们不能独立解决新增基线重复与历史所有权。当前没有生产证据支持替换恢复引擎或引入块级 CAS 的成本。

持久对象和引用显式配置 Git fsync，登记与作业启用 Storage durable 写入。首次初始化与引用落盘增加延迟；容量收益必须分别报告对象、索引与引用开销。目录 fsync 在支持的平台执行，不能把进程中断测试解释为全部平台的断电耐久性验证。进程身份以统一 UTC 解析，避免不同时区把活租约误判为 PID 复用。[Git GC](https://git-scm.com/docs/git-gc)的时间宽限不足以替代跨进程互斥。

## Consequences

行为测试覆盖共享去重、会话访问隔离、多工作区索引、历史恢复、分叉后删除原会话、删除中断恢复、JSON 缺失对象提示、无 refs 与 alternates、未知对象保留、迁移检查点重跑、packed-refs 合并和跨进程租约。独立基准使用临时 home，并明确区分当前流水线下的存储后端比较和旧版二进制性能比较。布局与使用规则见[存储参考](../../../reference/storage-and-paths.md)和[工作区架构](../../../architecture/workspace-and-files.md)。
