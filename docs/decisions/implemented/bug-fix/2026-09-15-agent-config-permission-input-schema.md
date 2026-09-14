# Decision Record: agent_config 使用可序列化的权限输入

Status: implemented

## Problem

`agent_config` 的 permission 参数直接引用包含 Zod transform 的配置解析器，生成模型工具定义时抛错并被跳过。CRUD 直接调用测试无法覆盖这种模型不可用状态，注册表验证又没有加载 runtime-local 工具。缺陷与测试遗漏记录在[复盘](../../../postmortem/0017-agent-config-permission-schema.md)。

## Decision

`AgentConfig.Input.Create/Update` 使用无 preprocess/transform 的 `PermissionInput` 接收权限值，工具执行前再调用既有 `Permission` 解析器。缺省 permission 保持键不存在，字符串简写、规则顺序和已知权限字段校验继续由领域解析器负责。复用已有修复提交 `4242ff5f4` 的实现，并增加更新与拒绝写入的回归覆盖。

工具参数需要生成模型可消费的 JSON Schema；持久配置的权限解析器同时包含规范化逻辑，不能直接序列化。采用可表示的输入联合类型，将标准化留在执行入口，使注册、模型可用性和配置写入各自可验证。

## Alternatives considered

**放宽所有工具的 JSON Schema 转换。** 影响范围超过单一工具，可能隐藏其他无法表示的字段，且 preprocess 的内部字段不应向模型暴露。

**给工具手写独立 JSON Schema。** 会增加与 Zod 参数校验分别维护的定义。

**从工具中移除 permission。** 会删减用户可配置能力。

## Consequences

`agent_config` 可被正常发现和展开。输入类型允许通用权限规则，执行前仍由领域解析器拒绝已知权限字段不接受的形式；拒绝发生在配置写入前。runtime-local 的注册表测试覆盖所有贡献工具的对象根 schema，补充 create/update 权限、内部字段隔离、字符串简写及权限顺序验证。工具描述和授权策略不变。
