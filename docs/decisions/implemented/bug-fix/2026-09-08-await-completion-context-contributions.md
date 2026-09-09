# Decision Record: Await contributed model work before rollout completion

Status: implemented

## Problem

完整产品的经验编码在助手回答完成后调用模型，但完成回调没有返回其 promise。执行循环因而在编码和奖励计算仍有活动调用时关闭账本，正常 `send` 也会报错或等待超时。仅运行核心及关闭经验编码的组合测试无法发现这种时序。

## Decision

完成贡献可以返回异步工作；处理器、收件箱和终态修复路径必须等待已注册贡献全部结束，再进入后续完成步骤。一个贡献失败时，仍等待其它贡献结束，并保留错误。Library 返回完整编码、失败重试、插件后置操作与奖励计算的 promise；全部模型调用继续使用原有 Harness 的取消、预算和证据上下文。回答文本仍按原有流式事件显示。

## Alternatives considered

**在 CLI 中禁用经验编码。** 不采用，因为完整产品的默认能力必须保留，且会掩盖运行时生命周期缺陷。

**允许账本带活动调用结算。** 不采用，因为这会丢失消耗、结果与失败证据，并使恢复结果不确定。

## Consequences

运行完成会等待其贡献的模型工作；普通经验编码失败仍按 Library 原有规则记录和处理。核心保持可选贡献接口，不依赖 Library。受控 promise 回归验证等待与错误保留，真实完整产品执行验收保留默认 Library 能力。
