# Decision Record: Preserve source stability and prerequisite completion during validation

Status: implemented

## Problem

并行质量检查中，包验证调用 SDK 完整生成，生成器清空 `src/gen` 时，typecheck 正在读取这些文件，导致同一份源码出现偶发缺失模块。门禁调度器还把“前置任务已开始”当成“前置任务已完成”；用相同短延时验证结束顺序的测试没有覆盖这个窗口。

## Decision

SDK 包验证使用只编译现有生成源码的入口。显式生成仍负责刷新完整服务 API 和客户端；普通发布包验证不改写生成源码，遵守既有[只读包验证决定](../process/2026-08-21-package-check-read-only-gate.md)。门禁依赖通过已经记录的完成结果满足，独立任务继续并行运行。

## Alternatives considered

**重试失败的 typecheck。** 不采用，因为重试保留了生成文件缺席的窗口，也可能掩盖真实类型错误。

**串行执行所有门禁。** 不采用，因为保持包验证只读可以直接消除共享源码竞争；独立检查仍可并行。前置任务完成的条件则由调度器直接保证。

## Consequences

SDK 编译测试验证所有生成文件的修改时间保持不变且产生公开客户端产物。门禁测试用受控 promise 阻塞前置任务，确认独立任务可以执行、依赖任务必须等待完成，不依赖机器速度。完整 SDK 生成仍会改写生成文件，须作为明确的生成工作运行。
