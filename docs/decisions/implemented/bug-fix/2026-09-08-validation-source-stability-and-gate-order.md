# Decision Record: Preserve source stability and prerequisite completion during validation

Status: implemented

## Problem

并行质量检查中，包验证调用 SDK 完整生成，生成器清空 `src/gen` 时，typecheck 正在读取这些文件，导致同一份源码出现偶发缺失模块。门禁调度器还把“前置任务已开始”当成“前置任务已完成”；用相同短延时验证结束顺序的测试没有覆盖这个窗口。

## Decision

SDK 包验证和 workspace 打包使用只编译现有生成源码的入口，核心打包不需要启动完整产品 API 生成器。显式生成仍负责刷新完整服务 API 和客户端；普通发布包验证不改写生成源码，遵守既有[只读包验证决定](../process/2026-08-21-package-check-read-only-gate.md)。门禁依赖通过已经记录的完成结果满足，独立任务继续并行运行。发行 wrapper 和包验证共用完整 CLI 资产装配，避免验证包漏带平台解析器却仍通过 manifest 检查。CI 健康检查明确使用临时 home、固定 loopback 端口与退出清理。

## Alternatives considered

**重试失败的 typecheck。** 不采用，因为重试保留了生成文件缺席的窗口，也可能掩盖真实类型错误。

**串行执行所有门禁。** 不采用，因为保持包验证只读可以直接消除共享源码竞争；独立检查仍可并行。前置任务完成的条件则由调度器直接保证。

## Consequences

SDK 编译测试验证所有生成文件的修改时间保持不变且产生公开客户端产物。门禁测试用受控 promise 阻塞前置任务，确认独立任务可以执行、依赖任务必须等待完成，不依赖机器速度。完整 SDK 生成仍会改写生成文件，须作为明确的生成工作运行。

普通 workspace `build` 编译可消费的模块；CLI 与 Product Runtime 使用 `dist/modules`，不清除显式发行产生的平台目录。Turbo 的依赖构建不能隐式触发所有平台二进制发行，否则本机测试会因缺少其它操作系统的 sandbox 资产而失败。显式的 CLI/Product Runtime `script/build.ts` 继续负责原有二进制发行流程。

Plugin/Plugin Kit 的包构建只写各自输出，移除对子包依赖的重复构建。原先 Turbo 已完成 Plugin 后，Plugin Kit 的构建与测试并行启动；构建再次清空 Plugin 的 `dist`，导致正在解析公开组件入口的模板测试失败。开发与发行入口通过 Turbo 依赖图构建指定包；包归档与验证按既有依赖顺序执行。

文件监视器的正向断言等待真实变更通知，不以固定 400 ms 睡眠假设 OS 已完成事件投递和去抖；全图负载曾使通知晚于这一窗口。仍检查通知次数、忽略生成输出和关闭行为，测试总超时继续约束通知缺失。

Linux 安装行为 CI 显式选择 `SYNERGY_BUILD_TARGETS=linux-x64`，与 Ubuntu 可执行 ABI、已构建的 sandbox helper 和待执行二进制一致。`--single` 原有的同系统同架构多 ABI 选择保持不变；完整发行及独立 helper 矩阵仍检查其它目标，不能通过关闭必需资产检查让安装测试通过。

插件内存回收测试按现有启动与关闭期限等待新进程成为 active，替代 100 次 1 ms 轮询的机器速度假设。仍验证旧代回调不影响新代、新 PID、监视器停止、进程数量和回收证据，并在断言失败时关闭任务拥有的插件进程。
