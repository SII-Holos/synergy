# Decision Record: Preserve native image tool results in the benchmark bridge

Status: implemented

## Problem

原生 Codex 的图片工具会返回 Responses `function_call_output`，其中 `output` 是含 `input_image` 的内容数组。评测器原有文本桥接在模型请求发出前拒绝该合法原生结果，导致图片任务中断；之后在未完成候选上执行的零分判题不能证明模型完整解题失败。仅覆盖 shell 工具往返的预检没有覆盖这个边界。

## Decision

[协议桥](../../../../benchmark/src/synergy_bench/bridge.py) 以 `responses-chat-v2` 双向映射 Responses 图片块与 Chat Completions 图片块，保留角色、工具调用身份、文本/图片顺序、URL 或 Data URL 字节及 `detail`，纯文本路径保持原有行为。映射适用于普通消息及原生函数/自定义工具结果；文件引用、音频及未知图片字段显式拒绝。原生请求和转换后请求仍分别留存，dispatch 前的拒绝不加入已发出请求或 token 计量。

[GLM-5.3-Flash 官方文档](https://docs.z.ai/guides/vlm/glm-5.3-flash) 给出图片 URL、Base64 Data URL 和多图片输入格式；这只作为内容格式来源，不推断所有 provider 的 tool 角色均接受图片。实际 provider 原生图片工具往返另行验收。单元测试覆盖双向内容与拒绝语义，真实 HTTP 测试核对请求字节和计量，原生 Docker 矩阵通过两个确定性模型、两种协议调用 Codex 的 `view_image` 后再调用 shell，并保留既有五种 harness 的 shell 往返检查。

## Alternatives considered

**将工具图片改写成用户消息。** 会改变历史角色与用户意图边界，不能用于声称保留原生完整能力的比较。

**丢弃图片、转为文本或在任务中禁用图片工具。** 会改变模型可见信息或标准能力，无法修复完整能力实验的兼容性。

**把桥接拒绝后的零分当作解题错误。** 混淆评测器中断与完成后的答案错误，阻止对客观故障的可审计恢复。

## Consequences

图片工具结果可以沿原生调用链传递，同时不引入模型循环或修改候选。内容映射能力与 provider 验收结果分开记录；无法表示的其他模态仍不被默默支持。改变桥接版本要求新冻结 evaluator 和单独声明的恢复实验，旧实验保持只读、使用原 recorded evaluator 续跑，所有失败、预检和恢复成本保留。[原生矩阵边界](../architecture/2026-09-14-benchmark-native-harness-matrix.md) 继续适用。
