# Decision Record: Distinguish runtime namespaces across package ownership

Status: implemented

## Problem

源码运行通过不能证明编译发行物正确。Bun 1.3.14 打包两个同名 TypeScript namespace 时，即使使用别名导入，内部引用仍可能绑定到当前 namespace。完整产品生命周期因此递归调用自身，模型 schema 和工作流委托也可能变成未定义值。仅检查安装、帮助、健康端点和资产无法覆盖这些执行路径。

## Decision

按职责命名实际实现：Harness 保留 `RuntimeHandle`，产品装配使用 `ProductRuntimeHandle`；模型 schema 保留 `ModelsDev`，运行时目录使用 `ModelsCatalog`；核心会话工作流机制保留 `SessionWorkflowService`，业务工作流使用 `WorkflowSessionService`。所有消费者同步更新，纯类型消费者直接依赖 schema。产品命令、HTTP API、持久化字段与安装名称保持不变。

CI 分别构建核心和完整产品，并对两个实际二进制复用同一套仓库外执行验收：模型协议、文件与 shell 工具、权限、预算、取消、恢复及导入导出。模型和工作流另用真实 Bun bundle 验证 schema 调用与会话清理，不以源码名称断言代替运行结果。

## Alternatives considered

**只增加 import alias。** 不采用。最小本地复现中，打包器会消除 alias，namespace 闭包参数仍遮蔽被导入的实现；模块 namespace import 也有同样结果。

**复制生命周期或工作流实现。** 不采用。重复实现会破坏单一核心机制及同一会话锁的约束。按所有者区分名称后继续调用原有核心实现。

## Consequences

新业务包的程序入口名称更明确；使用这些新入口的源码消费者须同步更新。类型检查、源码测试、workspace tarball 测试和编译二进制测试各自覆盖不同故障，完整产品执行必须作为独立的发行验收保留。
