# Decision Record: Agent 配置 CRUD 服务 + agent_config 折叠工具 + agent-manage Skill

Status: implemented

## Problem

Agent 定义只能靠用户手改配置文件（`.synergy/agent/*.md` 或 `60-agents.jsonc`），没有服务化的读写路径，错误配置静默失效：

- 拼错 `visibleTo`/`delegationGroups` 引用 → agent 静默不可见，无任何提示（`delegation.ts` 只做字符串匹配）。
- `default_agent` 指向不存在/已禁用/非 primary/hidden 的 agent → 无警告的隐式排序回退，且 `list()` 不过滤 subagent/hidden，schema 描述的 "Must be a primary agent" 从未被强制。
- 修改/删除/禁用 agent 没有任何命令或 API；CLI `agent create` 直写文件、绕过校验，与 Settings 的 domain-update 路径形成两条并行写路径。

原 issue #584 提议新增 `agent-creator` Primary Agent 作为对话入口；经讨论（issue 评论 #issuecomment-5612246113）确定一次性任务不值得让用户切换 Primary Agent，且 `ToolExposure` 组折叠机制零成本可用。

## Decision

- **`AgentConfig` CRUD 服务**（`packages/harness/src/agent/config-crud.ts`）：create/update/setDefault/describe/list/remove 六个操作。存储双轨遵循既有惯例——带 prompt 的 agent 写 markdown 文件（项目 `.synergy/agent/` 默认，`scope: "global"` 写全局；CLI `--path` 走 directory scaffold 模式不强制激活），短覆盖/disable 走 `60-agents.jsonc` 的 `Config.domainMutateWithChange("agents", …)`（锁内读改写 + 聚合校验）。删除分 `disable`（软，可逆，内置 agent 唯一允许的移除）与 `delete`（定位 owning layer：删 md 文件或 `replace-domain` 移除 jsonc 键）。所有写入经 `Agent.reload()` + `RuntimeReloadExecutor.reload` 级联刷新。
- **写入校验**：Zod schema + `model` 必须含 `/` + 跨 Agent 引用检查（`visibleTo` 每项必须匹配现有 agent 名或任一 agent 声明的 `delegationGroups` 身份，未解析即拒绝并点名）。
- **`default_agent` 显式语义**（`agent.ts`）：`Agent.defaultAgent()` 过滤 subagent-only/hidden/不存在目标，`log.warn` 显式警告原因后回退 `synergy`；`AgentConfig.setDefault` 在写入侧前置拒绝。`Agent.state()` 加载期对未解析 `visibleTo` 引用逐条 warn（兜住手改文件路径）。
- **`agent_config` 工具**（runtime-local，默认折叠组 `agent-config`）：discriminatedUnion 包 `input` 的动作式单工具；taxonomy `platform.config` stateful；UI 注册走 `TOOL_TITLE_DESC`/`activity.ts`/`message-part` case + lucide `bot` icon。
- **`agent-manage` 内置 skill**：对话式流程（收集需求 → describe 查冲突 → 摘要确认 → 写入 → 提议 set_default → describe 验证），字段参考下沉 `references/fields.txt`。
- **CLI 收敛**：`synergy agent create` 保留交互式 LLM 生成，持久化改走 `AgentConfig.create`——一条当前代码路径。

## Alternatives considered

- **新增 `agent-creator` Primary Agent**（原 #579 方案）— 否决：一次性任务不配切换 Primary Agent 的交互成本；新增 Primary Agent 是用户可见产品面（@ 菜单、默认 agent 选择器）；skill description 触发 + 组折叠展开已满足"纯对话"意图。
- **独立的 agent 配置 HTTP CRUD 路由** — 否决：`PATCH /config/domains/:domain` 已覆盖 Settings 场景；工具即模型侧接口，加路由徒增面。
- **全部写 `60-agents.jsonc`（单一存储）** — 否决：仓库文档与 CLI 先例都以 markdown 文件为主存储（prompt 体量大、可手编、git 友好）；jsonc 适合短覆盖。服务按 prompt 有无自动分层，尊重既有语义而非新建。
- **在 `list()` 里过滤 primary/hidden** — 否决：`list()` 语义被 modelRoleSummaries 等消费方依赖；过滤收在 `defaultAgent()` 内，`setDefault` 写入侧前置校验。

## Consequences

- 对话、CLI、手改文件三条路径共享同一套校验与刷新语义；手改路径至少有加载期 warn 兜底。
- `default_agent: "developer"`（subagent）这类原本"意外可用"的配置现在会回退 `synergy` 并告警——有意的行为收紧，product-runtime 旧测试已随契约更新。
- 无持久 schema 变更、无迁移；markdown/jsonc 写的都是既有格式，单 PR 可整体回滚。
- agent 工具卡片在 UI 有最小呈现（title/subtitle/args），无自定义 renderer——BasicTool 兜底足够，后续需要再加。
