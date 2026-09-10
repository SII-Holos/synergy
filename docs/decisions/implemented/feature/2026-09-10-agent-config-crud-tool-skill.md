# Decision Record: Agent 配置 CRUD 服务 + agent_config 折叠工具 + agent-manage Skill

Status: implemented

## Problem

Agent 定义只能靠用户手改配置文件（`.synergy/agent/*.md` 或 `60-agents.jsonc`），没有服务化的读写路径，错误配置静默失效：

- 拼错 `visibleTo`/`delegationGroups` 引用 → agent 静默不可见，无任何提示（`delegation.ts` 只做字符串匹配）。
- `default_agent` 指向不存在/已禁用/非 primary/hidden 的 agent → 无警告的隐式排序回退，且 `list()` 不过滤 subagent/hidden，schema 描述的 "Must be a primary agent" 从未被强制。
- 修改/删除/禁用 agent 没有任何命令或 API；CLI `agent create` 直写文件、绕过校验，与 Settings 的 domain-update 路径形成两条并行写路径。

原 issue #584 提议新增 `agent-creator` Primary Agent 作为对话入口；经讨论（issue 评论 #issuecomment-5612246113）确定一次性任务不值得让用户切换 Primary Agent，且 `ToolExposure` 组折叠机制零成本可用。

## Decision

- **`AgentConfig` CRUD 服务**（`packages/harness/src/agent/config-crud.ts`）：create/update/setDefault/describe/list/remove 六个操作。存储双轨遵循既有惯例——带 prompt 的 agent 写 markdown 文件（默认 scope 跟随当前 Scope：项目内 project、Home 下 global；CLI `--path` 走 directory scaffold 模式不强制激活），短覆盖/disable 走 `60-agents.jsonc`（锁内读改写 + 聚合校验；overlay 写入用 `replace-domain` 整体替换，因为深度合并删不掉 `disable` 键）。删除分 `disable`（软删、可逆，写入**定义所在的层**——项目 agent 在其他 Scope 不受影响；内置 agent 唯一允许的移除）与 `delete`（删 owning markdown 文件 + 清掉 owning 层的同名 overlay，保留独立的全局定义，残留 overlay 会复活一个空白 agent）。markdown 所有权按 frontmatter `name` 解析（与 loader 的覆盖语义一致），嵌套名（`team/x`）自动建父目录。所有写入前检查 `AbortSignal`，配置操作通过共享写锁跨校验、读改写和 reload 串行化，markdown 另持路径锁；插件/外部 agent 拒绝 update/remove（配置层稀疏覆盖会吞掉插件定义）。update patch 的 `null` 语义为清除字段（`model: null` 让 `modelRole` 生效）。
- JSONC create 与 disable 都遵循显式或当前 Scope；项目 JSONC 覆盖全局 markdown 时，由项目层承担 describe/update/remove，避免改动全局定义；update 的 disable 标记参与图校验，禁用成功返回明确结果；markdown 的 `prompt: null` 清空正文。内置覆盖和重新启用也执行完整字段校验。
- **写入校验**：Zod schema + `model` 必须两半非空（`openai/`、`/gpt-5` 拒绝）+ 跨 Agent 引用检查（`visibleTo` 每项必须匹配现有 agent 名或任一 agent 声明的 `delegationGroups` 身份）+ **宿主图完整性**（对 create/update/disable/delete 后的整个 prospective 图做可达性检查：改动若使其他 agent 的 `visibleTo` 全部失配——如删掉它依赖的 delegation group、禁用它唯一可见的 agent——拒绝并点名受影响者；本来就不可达的 agent 保持既有加载期 warn 不阻塞）。
- **`default_agent` 显式语义**（`agent.ts`）：`Agent.defaultAgent()` 过滤 subagent-only/hidden/不存在目标，`log.warn` 显式警告后回退 `synergy`，`synergy` 本身被禁用时回退到任意可用可见 primary——没有可见 primary 时明确报错，绝不返回解析不到的字面量。`AgentConfig.setDefault` 在写入侧前置拒绝。`Agent.state()` 加载期对未解析 `visibleTo` 引用逐条 warn（兜住手改文件路径）。
- **`agent_config` 工具**（runtime-local，默认折叠组 `agent-config`）：discriminatedUnion 包 `input` 的动作式单工具；execute 接受 `ctx` 并把 `ctx.abort` 传给服务（取消后不再落盘/刷新）；describe 的模型可见 output 与 describe/create/update 的 metadata 携带 resolved agent 的有界投影（字段 + prompt 预览 + 前 20 条权限规则）；taxonomy `platform.config` stateful。
- **执法门分类**（`enforcement/gate.ts` + `util/capability.ts`）：`agent_config` 按动作分类——`list`/`describe` 为可绕过 `config:read`，其余动作为不可绕过 `config:write`（guarded 会话改 agent/权限/controlProfile/默认 agent 需审批）。
- **`agent-manage` 内置 skill**：对话式流程（收集需求 → describe 查冲突 → 摘要确认 → 写入 → 提议 set_default → describe 验证），字段参考（含 null 语义、图校验、分层 disable、插件边界）下沉 `references/fields.txt`。
- **CLI 收敛**：`synergy agent create` 保留交互式 LLM 生成，持久化改走 `AgentConfig.create`——一条当前代码路径。
- **UI 呈现**：`tool/renders/agent-config.tsx` 经共享 `tool-registry-lazy` 注册 BasicTool renderer（不 import message-part，避免测试 mock 泄漏破坏 barrel）；list 结果的 count 用 Lingui ICU 复数标签 `tool.label.agents`（zh-CN 已译），不再硬编码英文。

## Alternatives considered

- **新增 `agent-creator` Primary Agent**（原 #579 方案）— 否决：一次性任务不配切换 Primary Agent 的交互成本；新增 Primary Agent 是用户可见产品面（@ 菜单、默认 agent 选择器）；skill description 触发 + 组折叠展开已满足"纯对话"意图。
- **独立的 agent 配置 HTTP CRUD 路由** — 否决：`PATCH /config/domains/:domain` 已覆盖 Settings 场景；工具即模型侧接口，加路由徒增面。
- **全部写 `60-agents.jsonc`（单一存储）** — 否决：仓库文档与 CLI 先例都以 markdown 文件为主存储（prompt 体量大、可手编、git 友好）；jsonc 适合短覆盖。服务按 prompt 有无自动分层，尊重既有语义而非新建。
- **在 `list()` 里过滤 primary/hidden** — 否决：`list()` 语义被 modelRoleSummaries 等消费方依赖；过滤收在 `defaultAgent()` 内，`setDefault` 写入侧前置校验。

## Consequences

- 对话、CLI、手改文件三条路径共享同一套校验与刷新语义；手改路径至少有加载期 warn 兜底。
- `default_agent: "developer"`（subagent）这类原本"意外可用"的配置现在会回退 `synergy` 并告警——有意的行为收紧，product-runtime 旧测试已随契约更新。
- 无持久 schema 变更、无迁移；markdown/jsonc 写的都是既有格式，单 PR 可整体回滚。
- guarded 会话中通过 `agent_config` 写 agent 定义触发 `config:write` 审批（不可绕过）；读动作（list/describe）保持免审批。
- re-enable 会把 disable 标记从 overlay 中整体移除（而非写 `disable: false`），markdown 上方的空 overlay 自动消失，独立的空 JSONC 定义保留，避免残留条目在 delete 后复活空白 agent。
