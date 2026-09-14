# 权限规范化 schema 使 agent_config 不可用

## Executive summary

完整运行时已注册 `agent_config`，但生成模型工具定义时，其 permission 参数内嵌的 Zod transform 无法转换为 JSON Schema，解析器因此跳过该工具。CRUD 直接调用测试全部通过，Harness 注册表测试又没有加载 runtime-local 贡献，遗漏了模型可用性。修复将可序列化输入与执行前权限规范化分开，并在实际贡献注册表上测试。

## Summary

完整能力评测的原生日志显示 `agent_config` 被标为 schema failure。已注册工具数量和全新安装配置均不足以证明该工具可以被模型调用。直接执行 create、update 和 list 也绕过了故障所在的定义序列化步骤。

## Timeline

- 2026-09-15：从完整运行时日志确认工具因 transform 转换异常而被跳过。
- 核对已有修复提交 `4242ff5f4`，先引入其注册表测试；当前代码复现两项失败，九项 CRUD 测试通过。
- 复用权限输入与规范化修复，增加更新时省略权限、规则顺序、字符串简写和非法规则拒绝写入的覆盖。
- 冻结中的实验保留原版本和缺陷记录；修复版本必须使用新的实验身份，不能热替换并混算成绩。

## Root cause

`Schema.Permission` 通过 preprocess 捕获原始键顺序，再通过 transform 生成规范化权限对象。`agent_config` 直接把它嵌入 create/update 参数，`ToolResolver.registryInputSchema` 的默认 JSON Schema 转换因此抛错。现有测试只验证运行时解析或 Harness 自身注册表，没有覆盖 runtime-local 贡献进入模型工具定义的过程。

## Guardrails added

- [注册表测试](../../packages/runtime-local/test/tools/tool-schema.test.ts) 加载 runtime-local 工具，检查对象根 JSON Schema 和模型可见权限字段。
- [工具行为测试](../../packages/runtime-local/test/tools/agent-config.test.ts) 验证规范化、缺省字段、权限顺序及拒绝写入。
- [工具开发流程](../../.synergy/skill/add-tool/SKILL.md) 要求覆盖所属组件的注册表和内部规范化字段隔离。
- [实现决定](../decisions/implemented/bug-fix/2026-09-15-agent-config-permission-input-schema.md) 保留输入校验与领域规范化的职责。

## Lessons

完整能力清单必须同时验证注册和模型可用性。组件分拆后，通用注册表测试只能覆盖已加载的贡献；实际宿主缺少对应测试时，直接调用成功仍可能掩盖模型永远无法使用的工具。
