# Decision Record: Preserve model context through durable snapshots and appended updates

Status: proposed

## Problem

第一阶段的具体实现与验证由[持久 advisory context 决策](../../implemented/architecture/2026-09-28-durable-prompt-context.md)记录；本提案保留后续 provider 高优先级指令与动态工具协议等设计，不代表这些阶段已全部落地。

Synergy 已把动态 advisory context 放到历史之后，但该消息仅存在于当前请求投影中。下一次请求重新投影持久消息，再附加新 advisory context，因此上一请求的完整输入与模型响应未必能成为下一请求的前缀。工具目录变化、临时消息包装、历史图片淘汰及旧工具输出裁剪还会改变其他位置。已有证据与缓存数据见 [Codex harness 对照分析](../../../research/context-efficiency/2026-09-28-codex-harness-cache-analysis.md)，本提案讨论具体改造方式，不重复实验结论。

目标是让普通续跑保留已构造的模型上下文，在需要时追加有明确语义的变化，并让重启、压缩、回滚、导入和失败恢复使用一致的记录。目标不包括永久保留全部历史、冻结真实权限，也不保证任意 provider 返回某个缓存命中率。

分析基线为 Synergy `909fb14b6ca65418cfb8cf402da075419c077db4` 和 Codex `44fe510ce3ee61c8ef623adcbf89b901c73ddd61`。下文 Codex 行为是固定源码事实；Synergy 部分保留完整设计提案，已实现范围以第一阶段决策为准。源码链接采用当前包目录名称。

## Proposal

### 1. Codex 实际维护了什么

Codex 将模型会话历史、用于比较的上下文状态和恢复记录分开表达。

| 对象                           | 职责                                                       | 关键实现                                               |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------ |
| `ResponseItem` / history       | 保存模型消息、reasoning、工具调用及结果，供请求重放        | `context_manager/history.rs`                           |
| `WorldState`                   | 按固定 section 顺序收集当前指令、权限、环境、工具等状态    | `session/world_state.rs`、`context/world_state/mod.rs` |
| `WorldStateSnapshot`           | 保存每个 section 下一次比较需要的数据，不等同于整份 prompt | `context/world_state/mod.rs`                           |
| `WorldStateItem`               | 持久化完整状态或 JSON merge patch，用于恢复比较基线        | `session/mod.rs`、`session/rollout_reconstruction.rs`  |
| `TurnContextItem`              | 保存回合设置与参考上下文，支持继续和恢复                   | `session/mod.rs`                                       |
| compaction replacement history | 为新上下文窗口保存确定的替换历史及对应状态                 | `compact_remote_v2.rs`、`session/mod.rs`               |

源码定位见文末。这里有两个不同的“变化”：模型收到的是可理解的上下文消息；持久化层可以保存紧凑的状态 patch。Codex 没有把数据库 JSON patch 直接当作通用模型指令，也没有用一份新生成的 prompt 覆盖旧会话。

### 2. Codex 的正常流程

首次回合捕获 `StepContext`，其中模型设置、环境和工具属于同一次执行快照。`build_world_state_for_step()` 从这个快照构造多个 section；`record_context_updates_and_set_reference_context_item()` 在缺少参考状态时生成完整上下文，通过 `record_conversation_items()` 加入模型历史，再保存 world-state 与 turn-context 记录。`turn.rs` 的正常首次路径随后记录真实用户输入。

同一个回合内，`record_step_world_state_if_changed()` 用下一步的执行快照构造新状态，和上一状态比较；模型更新与持久化 patch 来自同一对快照。模型可见更新先进入 history，描述它的状态随后被记录，避免先把比较基线推进到模型历史中尚不存在的内容。

```text
首次：固定基础指令 | 初始上下文 | 用户输入
续跑：固定基础指令 | 初始上下文 | 用户输入 | 模型动作 | 工具结果
有变化：在上面的历史后追加上下文更新，再继续推理
无变化：不重复注入相同上下文
```

这是普通路径的结构。模型切换、压缩、回滚和失败恢复允许建立新的上下文基线，并不承诺所有情况下都只追加。

### 3. Codex 的 diff 是按语义生成的

`WorldStateSection` 让各领域声明稳定 ID、snapshot 和 `render_diff`。上一状态分为 `Absent`、`Unknown`、`Known`：没有可见记录、保留历史中有记录但缺少精确快照、拥有精确快照。这个区分可防止把“无法恢复状态”误判成“状态完全没变”。

| section     | 实际处理                                                                                    | 对 Synergy 的启发                                      |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 环境        | 比较工作目录、环境可用性、日期、时区、网络、文件系统等字段；被移除的环境有 unavailable 表达 | 变化按字段或完整小块表达，删除不是空字符串             |
| AGENTS 指令 | 内容不变不发送；变化时追加完整新指令并说明替换；消失时追加不再适用的说明                    | 只追加一个新值还不够，需要声明旧版本是否失效           |
| 权限        | 主权限不变且只新增允许的命令前缀时，可以只通知新增项；收回或其他变化可重新发送完整权限说明  | 允许增加和权限收回需要不同语义；执行层始终检查当前权限 |
| 保留状态    | 部分 section 除了检查 snapshot，还检查对应片段是否仍在 retained history                     | 记录“发送过”不能替代检查“本次模型仍能看见”             |

存储层使用 RFC 7386 风格 merge patch，`null` 表示删除；模型侧各 section 自己决定自然语言或结构化提示的表达。Synergy 第一版可以使用“比较 hash，变化后追加该 section 的完整替换说明”，不必立即实现所有字段级 patch；大文本再由所属领域提供更细的差分。

### 4. 恢复与压缩是这套机制的一部分

Codex 恢复时重建 surviving history，并按时间重放完整 `WorldStateItem` 和后续 patch。没有完整基线的 patch 不能独立建立状态。回滚会同时影响哪些历史项与状态记录仍然有效，不能简单选择整个 rollout 的最后一份 snapshot。

压缩会安装 replacement history，推进上下文窗口，并把对应的新基线一起记录；未保留的旧基线要清除或重建。部分 section 即使还存在 snapshot，若实际片段已不在历史中，仍需再次注入。由此避免“压缩删了权限提示，比较器却因为 hash 相同而不再补发”的问题。

### 5. Synergy 应优先复用现有消息存储

建议第一阶段把 advisory 上下文记成现有的内部 user 消息，不先建立一份与 Session transcript 平行的完整模型会话数据库。[Canonical Message Semantics](../../../architecture/session-and-messages.md#canonical-message-semantics) 已经具备这组字段：

```ts
{
  role: "user",
  origin: { type: "system", detail: "context_update" },
  isRoot: false,
  rootID: activeRootID,
  visible: false,
  includeInContext: true,
  parts: [{ type: "text", origin: "system", text: renderedUpdate }]
}
```

这是消息与 parts 合并展示的示意，不是可直接传给现有 API 的完整对象。应继续使用独立的 message/part ID、当前时间和既有写入接口，不新增 `synthetic`、`noReply` 等持久布尔，也不把 `origin: system` 当作模型 system role：第一阶段的文本仍是 user-role advisory context。

新增一个小的 `session/prompt-context.ts` 所属模块，负责 section 比较、更新计划、记录读取和写入。先覆盖既有上下文来源，不新增一套通用插件框架。Library 继续负责检索和内容，Workflows 继续负责工作流指令，Harness 负责排序、预算、持久化和投影。

建议为内部消息增加有版本的、经过 Zod 校验的专用 metadata；字段含义如下，具体名称在实现时确定：

| 字段                   | 含义                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| version                | 内部 context 记录格式版本                                                |
| preparation ID         | 一次逻辑模型步骤的准备身份，用于重试去重；不是每次 HTTP attempt 新建一个 |
| window anchor          | 该组记录所属的首次基线或已提交 compaction 边界                           |
| section ID / operation | 哪个上下文发生 snapshot、replace、remove 或一次性 event                  |
| comparison state       | 下一次比较所需的最小结构化字段、内容摘要及其文本 part 引用               |
| applicability          | 会话状态、root 任务上下文或指定事件的作用范围                            |
| captured revisions     | 必要的配置、workspace binding 和渲染版本，防止把不同捕获状态混合         |

模型看到的文本以消息 part 为准，comparison state 只保存比较需要的信息，不再存一份相同的大段记忆正文。第一版可每次只保存发生变化的 section 的完整比较状态，而不用对内部 metadata 再做 JSON patch。

比较基线应从当前 effective、compaction-aware 的 context 记录派生。循环内可以缓存最新状态，退出、回滚、压缩、重新绑定和删除时失效；恢复后根据持久记录重建。若需要独立索引，它必须是可重建的派生状态，不成为第二份权威。不要把必需的上下文仅放进 Rollout：Rollout 有独立的证据与容量保留策略，不能让普通会话恢复依赖可能被清理的观测记录。

### 6. 第一阶段的内容策略

| 内容                                  | 建议处理                                               | 不应采用的处理                                 |
| ------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| 工作目录、Scope/workspace、平台、日期 | 首次快照；有语义变化时追加替换或删除说明               | 每步保存同一完整 env；为了前缀稳定保留错误目录 |
| Library memory / experience           | 首次或检索结果实际变化时追加；标明本轮相关性和替换关系 | 每步复制全文；把检索结果提升为权限或系统规则   |
| coauthor 等稳定 advisory              | 首次或配置变化时追加                                   | 在每轮重复同一提示                             |
| Git health                            | 诊断状态变化时追加；解除时清除当前告警                 | 仅因诊断时间戳变化就追加；告警消失后什么也不说 |
| Cortex、Agenda、planning 提醒         | 使用稳定事件身份，按事件或状态变化追加；注明适用范围   | 每步重复倒计时；把提醒无限当作当前事实         |
| elapsed time、步骤预算提醒            | 在确有用途的边界记录一次；明确是当时的观察             | 为维持“实时”每次写入变化的秒数                 |
| agent 核心、权限、workflow 强约束     | 第一阶段保持既有高优先级路径，变化时承认前缀重建       | 为命中率把强约束降为 user 文本                 |

一次性提醒进入历史后仍会留在旧位置，但正文要明确它描述哪个事件、在哪个任务范围适用；失效应靠更新或范围语义表达。已经作为输入提交的记录不应因为“过期”直接在普通续跑中消失。上下文预算需要回收时，通过明确的压缩或重建边界处理。

### 7. 必须一起修改的调用顺序

[invoke.ts](../../../../packages/harness/src/session/invoke.ts) 在约 828 行先创建并持久化当前 assistant，随后才组装动态上下文。若直接在现在组装 `lateSystemParts` 的位置写入 context 消息，它可能在存储顺序中位于当前 assistant 之后，而本次请求又把它放在 assistant 之前；下一轮按真实 chronology 重建时仍会破坏前缀。

建议改成以下顺序，具体错误处理仍复用当前 processor / rollout 生命周期：

1. 确认存在真实待处理任务，并完成应 piggyback 的 Inbox 投递；内部 context 不得唤醒空闲 Session。
2. 捕获本步模型、工具可见集合、权限、workspace binding 与上下文来源；预留逻辑 preparation 身份。
3. 从有效模型 working set 恢复比较状态；计算候选更新，并生成一次稳定的渲染文本。
4. 把候选更新计入完整 prompt budget。需要 compaction 时先压缩，丢弃本次未提交的计划，然后重新捕获和计算；不能先推进基线再压缩。
5. 进入 Session 既有串行写入边界，确认捕获的相关 revision 仍适用；事务内先写 context 消息及 metadata，再写本次 assistant 壳。时间相同也必须按现有 ID tie-break 保持顺序，不能事后回填伪造时间。
6. 用相同的已提交 context part 和已捕获的工具/设置准备模型请求；后续步骤重放这些 part，不再次渲染旧 context。
7. 收到响应与工具结果后沿用现有持久化；下一模型步骤重新检查实际状态，仅生成新的变化。

上面的事务不执行插件、网络、工具或文件读取。内容准备、SecretMask 和必要的 artifact preparation 应在事务外完成；通过现有 [SessionUserMessageMaterialization](../../../../packages/harness/src/session/user-message-materialization.ts) 的幂等与事务机制复用写入能力。第一阶段的内部写入入口应由 Harness 控制，公共输入中的保留 metadata 不能伪造“已经注入”的比较基线。

预检失败不能为了记录错误而强行创建 context；仍要保留现有失败、取消和 accounting 的可观察结果。写入成功只代表上下文已经进入待重放历史，不代表 provider 已收到或缓存它。发送前崩溃后，应从相同记录恢复；HTTP 重试复用同一准备结果，不追加重复更新。模型失败恢复撤回部分生成内容时，需要显式识别历史重建，而不是重新执行已经完成的工具。

### 8. 不能遗漏的现有消费者

新增隐藏 user 消息会影响那些仍按 `role === "user"` 寻找边界的代码，必须在同一阶段处理，而不是等上线后再修。

| 位置                                                  | 已核实的行为                                      | 实现要求                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `invoke.ts::buildPlanningReminder`                    | 从最后一个 user 消息之后统计工具                  | context 更新不能把当前任务的工具计数重置；按 canonical task/steer 语义选择边界                              |
| `packages/library/src/recall.ts::extractLastUserText` | 先找最后一条 user，再过滤 system-origin text      | 若尾部是 context，它会返回空而不是继续寻找真实请求；应在选择消息时排除内部 context，并保留真实 steer 的含义 |
| `SessionUserMessageMaterialization`                   | 只把符合来源且有用户文本的消息交给用户消息观察者  | 继续保证 context 不触发用户输入 hooks、标题生成、回复调度和学习误归因                                       |
| `WorkflowUserWrapper` 与临时 steer wrapper            | 在投影阶段包装部分 user 文本                      | 记录并核对渲染版本与适用边界；普通续跑不能无意重包先前已经发送的内容                                        |
| `ProviderTransform.applyCaching`                      | 用 `<runtime-context>` 与尾部位置识别当前易变消息 | 新的持久 context 已属于稳定历史，应改用明确的投影分类，不能继续把它永久当作不可缓存临时尾部                 |
| `model-working-set` / compaction                      | 仅加载最新 compaction 边界和保留后缀              | 比较基线必须来自同一保留集合；摘要以前的 snapshot 不能让被删掉的 context 停止补发                           |

应使用 `MessageV2.deriveSemantics()` 和 `isSystemPart()` 的既有语义，不新增第二套基于任意 metadata、文本标签或 role 的根任务推断。Library 的检索选择仍由 Library 拥有，Harness 只传递具有明确用途的任务输入与上下文记录。

### 9. 再处理高优先级指令和工具更新

环境与记忆在当前布局中本来就是 user-role advisory，第一阶段可保持角色。权限、项目约束和 workflow instructions 不同：要实现它们的追加更新，需要保持原有指令优先级，并确认最终 provider 请求保留消息位置。

OpenAI Responses 的锁定 SDK 能把 `system` ModelMessage 转换为相应的 `system` / `developer` input 项，具体取决于模型策略。Anthropic 的锁定 `@ai-sdk/anthropic@2.0.98` 也有中途 system 消息路径；本次用完全替代网络的 fetch 夹具验证，它将初始 system 留在顶层，把后续 system 保留在 messages 中，并添加 `mid-conversation-system-2026-04-07` 标头。这说明不必先假定所有 SDK 都要重写；但 SDK 能生成请求不代表所有模型、代理与账号接受该 beta。

建议单独建立明确的 provider/model capability 来选择更新方式：已验证能保留中途高优先级指令的路由追加对应角色的替换说明；没有该能力或未验证的路由，继续更新高优先级 system，并将这次请求标记为前缀重建。不能把失效的安全策略冻结，也不能悄悄降级角色来追求缓存。

工具定义也单独处理：固定正常续跑中的序列与描述；注册表、权限和模型能力变化时重新判断可调用性。支持原生 tool search / additional-tools 的路由可以让新定义追加进入上下文；缺少该协议的路由则明确接受顶层定义变化造成的重建。禁止冻结已经撤销的权限，禁止只把 JSON schema 放进普通文本就假定 provider 已注册该工具。

首次版本可在已有 context 消息模型中承载 advisory 更新；只有进入高优先级指令阶段，才增加由可信 Harness 生成并经过校验的 model-role 投影能力。该能力必须检查导入与公开输入边界，不能让用户上传或外部消息通过 metadata 任意获得 developer/system role。

### 10. 恢复、压缩与迁移规则

| 场景                               | 必须实现的结果                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| 正常续跑                           | 相同状态不新增 context；更新顺序和已有文本不改变                                   |
| 进程重启                           | 从有效 context 记录恢复比较状态；不依赖退出后消失的进程 Map                        |
| context 已提交但请求未发送         | 继续重放该记录；不把它误报为缓存命中，也不重复注入                                 |
| 同一步 HTTP 重试                   | 重用相同已准备内容；不因重试生成新时间、事件或文本                                 |
| 新 root 任务                       | 会话级状态可延续；重新计算 root-scoped recall 和提醒，明确旧任务相关信息的适用范围 |
| compaction 成功                    | 安装新保留历史后，从实际可见状态建立新基线；必要时追加当前完整快照                 |
| compaction 失败                    | 旧基线保持有效，不提前切换 window anchor                                           |
| rollback / redo                    | 基线随 effective history 回退或恢复；不能读取已被排除记录的“最新状态”              |
| fork                               | 重映射所属身份；只继承被复制的历史状态，重新核对目标 workspace、权限和模型         |
| 跨 Home 导入                       | 保留历史证据，目标实时环境和权限重新捕获；导入 metadata 不成为授权或跳过注入的依据 |
| provider / wire model 切换         | 重建相关投影基线，沿用 encrypted reasoning 的 producer identity 检查               |
| 旧工具裁剪、图片淘汰、失败内容撤回 | 明确记录重建原因，重新检查保留 context；不把有意重写误判为普通追加                 |

沿用 Session 所有者的数据迁移与中央 runner，给新 context 格式建立有版本的兼容边界；不在请求 handler 中散落回填。旧会话从未持久化过的 runtime context 无法精确恢复，迁移不得补造“过去发送过”的内容。升级后从旧 canonical history 继续，在第一个合适调用边界记录当前真实快照，接受一次前缀变化。明确区分旧记录缺少新字段和存储损坏，不能遇到任意错误都按“没有基线”继续。

第一阶段无需改写全部历史或另建完整 wire journal。若未来为了某种 provider 的原始 opaque items 必须增加持久格式，应由该需求单独证明；现有 compatible reasoning 与 remote-compaction artifact 继续由已有模块负责。

### 11. 最小实施顺序与文件范围

| 阶段                     | 具体交付                                                                                                          | 主要文件/所有者                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A：免费请求诊断          | 捕获连续请求中首个语义差异，区分 system、tools、历史、尾部和参数；建立已有行为基线                                | `session/llm.ts`、`provider/transform.ts`、`provider/codex.ts`、现有 Rollout transport 测试                                                                                    |
| B：持久 advisory context | 小的 section 比较器、隐藏消息、幂等写入、正确 chronology、预算、恢复与压缩闭环；替代正常主循环的临时 late context | 新 `session/prompt-context.ts`，`invoke.ts`、`user-message-materialization.ts`、`message-v2.ts`、`prompt-budgeter.ts`、`compaction.ts`、`model-working-set.ts`、Library recall |
| C：指令与工具能力        | 支持路由追加高优先级更新和原生工具定义，其他路由显式重建                                                          | provider capability / transform、`tool-resolver.ts`、`tool/exposure.ts`、workflow/context contributors                                                                         |
| D：持续减少历史重写      | 稳定 wrapper、插件变换和输出投影；用观测数据判断图片/工具裁剪时机                                                 | `workflow-user-wrapper.ts`、plugin hooks、`message-v2.ts`、compaction                                                                                                          |

建议把 A 和 B 作为最先落地的工作，B 必须连同生命周期与消费者修复一起验收。C 按路由拆分，避免让 GLM 的主路径依赖 Codex 专有协议。WebSocket continuation 可以在模型输入稳定之后单独评估，不是 B 的前置条件。

预算和最终请求必须使用相同的 context 文本与渲染版本。对现有 budget/final 两次 system transform，以及每步的 messages transform，第一阶段先保留插件兼容性并检测它们是否改变已有前缀；检测到变更时说明是重建，不能忽略插件输出或冻结其授权更新。后续若统一为单次 prepared prompt，需要单独明确 hook 调用阶段与副作用约定。

### 12. 权限、DAG、todolist 与工具定义分别如何组装

这四类内容不是同一种 prompt 来源。权限说明属于高优先级指令；DAG/todo 是领域状态，通常通过工具调用及结果进入历史；工具定义则还必须进入 provider 的真实工具协议。下面区分现有路径和建议，不能把所有内容统一塞进一条 user-role context 消息。

| 对象     | Synergy 已核实的当前路径                                                                                                              | 建议的模型上下文策略                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 权限     | `invoke.ts` 解析 effective control profile、workspace roots，经 `buildPermissionContext()` 放进 `systemParts`；调用工具时另有执行检查 | 首次完整高优先级说明；未变不生成新说明；变化追加同等优先级的替换或增量说明，不支持的 provider 重建 system |
| DAG      | `dagwrite`/`dagread`/`dagpatch` 通过工具结果返回图；子任务还通过 `buildDagUpstreamContext()` 得到已完成前置节点结果                   | 已保留的工具调用/结果是已有观察，不再每步复制全图；外部更新追加缺失的变化；压缩后按需补一次当前快照       |
| todolist | `todowrite` 参数含完整列表，结果再次输出完整列表；`todoread` 返回当前列表                                                             | 完整调用参数已经保留且写入成功时可返回短确认；外部变化或历史丢失时补变化/快照                             |
| 工具定义 | `ToolResolver` 收集并过滤定义，拆成模型 `ToolCatalog` 与执行回调；`LLM.stream()` 把定义传给 SDK `tools`                               | 固定核心定义；动态工具按已验证的原生协议加载，或明确重建顶层定义；schema 不与任务状态混合                 |

当前 `synergy`、`synergy-max`、`synergy-flash` 的内置默认配置允许 DAG，禁用 `todowrite`/`todoread`，用户配置仍可覆盖；部分子代理有 todo 工具。不能把所有会话都按“DAG 和 todo 两套列表每轮重复注入”诊断。[默认代理配置](../../../../packages/harness/src/agent/builtin-primary.ts)、[DAG 工具](../../../../packages/local-runtime/src/tools/dag.ts)、[todo 工具](../../../../packages/local-runtime/src/tools/todo.ts)是本节当前行为的源码依据。

#### 权限：缓存模型说明，不缓存授权结论

权限应有两条路径：一次模型步骤捕获的说明用于本次 prompt；真实调用到达执行层时，仍按当前有效策略、路径和参数检查。`buildPermissionContext()` 输出的是 profile、审批行为、sandbox/network、工作目录和拒绝能力的说明，并不是保存权限、会话规则和每次审批结果的完整序列化。一次性授权不能被误渲染成永久授权，也不能为了保持前缀而把新的权限状态延后到下一次压缩。

Codex 的 [PermissionsState](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/context/world_state/permissions.rs) 将主说明 hash 与允许的命令前缀分开比较：主说明相同且只增加前缀时通知新增项；其他变化可重发完整权限说明。Synergy 可复用这种语义，但不能照抄其权限分类或假定自己的全部权限都能转换成 shell prefix。

#### DAG：保留工具历史，对外部变化追加实际结果

模型调用 `dagpatch(A=completed)` 后，调用参数和工具结果本来就属于追加历史；无需再生成同一变化的 `<dag-update>`。但 Synergy 的后端会验证、修复和自动推进节点，因此不能直接把所有写工具结果都缩成 `OK`。建议保留实际接受的节点变化、自动修正/推进、失败项和必要的依赖信息；完整 UI metadata 可以继续提供图，而模型文本只返回本次实际变化。`dagread` 保持显式读取完整当前状态的用途。

后台任务完成时，[Cortex manager](../../../../packages/harness/src/cortex/manager.ts) 会更新父 Session 的 DAG，并通过有 delivery key 的 Inbox 通知父代理。建议把 DAG 变化与已有通知关联，补充节点状态和必要结果引用，避免相同完成事件被工具结果、Cortex 通知及通用 context 连续播报三次。保留现有通知的 `steer` 调度语义；普通状态同步仍只能 piggyback，不因为记录 context 新增模型调用。子代理首次接收其依赖结果，后续只在相关结果变化时补充；不把父图全部状态每轮塞给每个子代理。

去重依据必须是“该状态已在当前有效模型历史中表达”，不能仅看 UI 是否收到 `dag.updated`。建议由 owning domain 提供实际变更及身份，再在模型记录中保存已观察的身份或摘要；目前 DAG/todo 存储是列表，不应把示例 revision 当作已有字段。工具观察被截断、裁剪或压缩后，比较基线随保留集合失效，必要时补当前快照。并发写入及事件通知之间的一致性也必须由领域写入方负责，不能靠 prompt 比较器重新发明状态。

#### todolist：可以借鉴 Codex 的短工具确认

Codex [update_plan 的规格](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/tools/handlers/plan_spec.rs)要求调用参数给出计划；[handler](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/tools/handlers/plan.rs)发送 `PlanUpdate` 事件，并返回简短的 `Plan updated`。该路径没有把完整列表再次写入工具结果。它是 checklist 工具，不应当作 Synergy 依赖图调度行为的证明。

Synergy `todowrite` 可以在实际写入内容与保留调用参数一致时采用类似确认，保留 UI 所需 metadata；若参数被投影裁剪、后端规范化或实际写入不一致，则必须提供有效差异或当前快照。计划变化仍作为新调用追加，旧调用不改写。压缩后是否需要补列表，要检查当前上下文是否已保留可信的当前计划，而不是每次机械复制。

#### 工具定义：分别稳定 schema、发现目录和执行注册表

核心工具的名称、描述、JSON Schema 与顺序保持确定，不把运行时间、DAG 进度、当前可执行节点或审批次数写进 description/schema。发现目录描述“还能找什么”，与注册后的完整定义分开；目录变化也能按 namespace 追加说明。Codex 的 [ToolsState](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/context/world_state/tools.rs)就分别渲染新增与移除的 deferred namespace。

支持原生 tool search 的 Codex 路径通过 [ToolSearchOutput](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/tools/context.rs#L218)把完整工具定义放进协议历史项；普通文本列出 schema 不能替代这项协议。也不能认为 Codex 所有路径都只在尾部注册工具：[client.rs](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/client.rs#L893)的普通 Responses 路径仍有顶层 `tools`，Responses Lite 则会按内容稳定身份构造前置 `AdditionalTools`。这些前置定义改变时仍需检查前缀变化。

Synergy 的默认实现可先维持现有 `ToolCatalog`/execution callbacks 分离，稳定不变的定义，并对 `expand_tools`、插件更新和权限导致的定义变化记录重建原因。若某 provider 没有原生增量工具协议而又需要稳定顶层工具集合，可单独评估固定的“搜索＋调用已注册工具”入口：搜索结果携带说明，调用入口接收真实工具身份与参数，后端继续校验真实 schema、执行真实工具的权限与调度。它以失去部分 provider 级专用参数约束、增加调用复杂度为代价，需单独验证质量，不作为第一阶段的必要抽象，也不冒充 Codex 已统一采用的方式。

这部分新增验收应覆盖：调用参数已含列表时不重复正文；DAG 自动推进与部分失败仍被模型获知；后台状态变化只通知一次；已有通知不被去重误吞；压缩后可以恢复当前计划；权限撤销对已保留工具句柄仍立即有效；固定工具入口不能绕过真实工具 taxonomy、权限和参数校验。

## Alternatives considered

**只在 `LLM.promptMessages()` 中把尾部字符串追加到数组。** 不足以解决问题：数组已在追加，但没有持久化 context、比较状态及正确的消息 chronology；重启和下一步投影仍不能重放相同历史。

**每步把完整 runtime context 永久保存。** 能改善序列连续性，但重复记忆、环境和提醒会持续放大输入与存储。按 section 去重和明确替换/删除语义是第一版的必要组成部分。

**立即照搬 Codex 的完整 WorldState、rollout 与 Responses 数据模型。** Codex 的恢复和协议设计值得借鉴，但 Synergy 已有 Session 消息权威、SQL 事务、Inbox、跨 provider 投影和 Rollout 证据。第二套完整会话权威会增加同步、迁移和导入复杂度；先复用现有内部消息语义。

**优先改成 `previous_response_id` 或 WebSocket。** 这些是传输/状态复用能力，不能修复本地已经改变的逻辑前缀，也不能替代跨 provider、恢复和压缩语义。OpenAI 的[会话状态文档](https://developers.openai.com/api/docs/guides/conversation-state)也允许客户端管理并重放历史；本提案的模型输入目标不依赖改用服务端会话存储。

**冻结全部 system、工具和历史，永远不压缩。** 会让实时权限、项目指令、工具可用性和上下文预算失真。正常阶段保留前缀，必要变化显式重建，才是可维护的约束。

## Acceptance criteria

首先做确定性验证，断言最终 SDK/provider 请求而不只断言内部数组。真实 provider 的缓存收益属于后一层验证，不能以源码测试代替。

| 夹具                                        | 断言                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 首次请求与连续三个工具步骤                  | 初始 context 只记录一次；后续保留旧 context 与历史顺序；正常路径不出现临时尾部搬移        |
| 工作目录改变、状态不变、状态移除            | 分别追加一次更新、零更新、明确清除；模型文本和 metadata 基线一致                          |
| 相同毫秒创建 context 与 assistant           | 重读、重启后的排序与第一次请求一致                                                        |
| preparation 重试与事务回滚                  | 不重复注入；回滚不残留已推进的基线或孤立的 message/part                                   |
| 写后崩溃、发送中断、部分流失败              | 原始记录可重放，usage/失败可归因，不重复工具效果                                          |
| 隐藏 context 插入                           | 不成为 root、不触发 idle 唤醒/额外回复；Library query 与 planning 计数仍基于正确输入      |
| compaction 成功/失败、连续压缩              | 新基线对应实际保留历史；失败不提前推进；不重复使用已丢弃 opaque artifact                  |
| rollback、redo、fork、导入                  | 有效历史与比较状态一致，目标环境重新核验，外部 metadata 不能获得指令权限                  |
| 图片上限、旧工具裁剪、wrapper / plugin 变换 | 首个变化有明确归因；不声称这些请求满足完整追加不变量                                      |
| OpenAI-Codex reasoning                      | 兼容的完整 encrypted items 保留；不兼容 producer 不回放；最终 splice 顺序正确             |
| Anthropic / OpenAI-compatible               | 最终角色、内容顺序、cache breakpoint 与真实工具 schema 正确；仅在已验证能力上发送特殊更新 |
| 长会话与多 Runtime                          | 历史加载和比较状态缓存有界；相同 Session ID 的不同 Runtime 不串状态                       |

复用 owning package `test/` 下的 invoke、message-v2、compaction、input、rollout、provider 和 Library context suites；新增测试先表达预期行为失败，再实现。使用真实临时 Storage/Scope 夹具及假 provider transport，网络与 SQL 事务分离。需要修改公开 schema 或 capability 配置时，同步生成 SDK、更新配置/help/所属 Skill 和架构文档；不手改生成页面。

建议诊断指标包括：首个变化分区、完整保留的历史项/内容块、context 新增字节与事件数、指令/工具版本变化、主动重建原因，以及 input/cache read/uncached input/output、请求数、TTFT 和任务测试结果。比较应针对最终模型可见字段，排除传输 trace ID 等无关字段；JSON 字节共同前缀只能作为诊断量，不能标成服务端 tokenizer 的可缓存 token。移动的 cache-control 标记和 SDK 合并相邻消息也需要单独解释。

免费验证通过后，先在同 provider、wire model、设置与请求间隔下比较固定轨迹，再做小规模实际任务配对；质量与完整任务总开销是验收依据。原 local24 历史数据不替代新实现的验证，不预先承诺某个 hit、token 或费用改善比例。

## Risks

最主要的风险是上下文语义退化：旧提醒持续有效、权限被降级、内部 user 消息改变调度，以及数据库状态声称已注入但模型投影已经丢掉对应片段。上面的作用范围、角色能力检查、canonical semantics 和保留历史校验必须在同一阶段覆盖。

第二个风险是为了保存前缀增加过多持久记录和上下文。按变化追加、在第一次入历史前限制工具输出、避免正文重复存储，并通过正常压缩重建基线；不要用后台付费保活或额外模型轮询来维持命中。

第三个风险是跨 provider 的“看起来一样”并不等于最终序列一致。SDK 合并、工具 schema、reasoning 转换和 remote splice 都在内部 `ModelMessage[]` 之后发生；阶段 A 的最终请求验证必须随 B/C 的改动继续运行。

本提案记录完整设计；首阶段实现与测试范围见[已实施决策](../../implemented/architecture/2026-09-28-durable-prompt-context.md)。没有执行付费模型实验。设计阶段的 Anthropic SDK 探针使用假 fetch，不验证真实端点的 beta 支持。

### 固定源码定位

- [Codex WorldState section、比较状态、render 与 merge patch](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/context/world_state/mod.rs)。
- [每步收集执行上下文](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/session/world_state.rs)，[首次捕获与记录顺序](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/session/turn.rs#L253)。
- [同回合状态变化记录](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/session/mod.rs#L3679)，[首次与跨回合参考状态](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/session/mod.rs#L4658)。
- [AGENTS 替换与移除](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/context/world_state/agents_md.rs)，[权限变化](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/context/world_state/permissions.rs)，[环境变化](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/context/world_state/environment.rs)。
- [恢复 surviving history 与 world-state 基线](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/session/rollout_reconstruction.rs)，[压缩时安装新历史](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/compact_remote_v2.rs#L323)。
- Synergy [模型上下文投影](../../../architecture/session-and-messages.md#model-context-projection)、[Prompt Assembly](../../../architecture/llm-loop.md#prompt-assembly)、[Agent storage](../../../architecture/agent-storage.md) 是实现必须保持的现有约束。
- SDK 版本由 [Local Runtime package](../../../../packages/local-runtime/package.json) 与 [锁文件](../../../../bun.lock) 固定；本次检查的 Anthropic 转换器位于安装包 `dist/index.mjs` 的 `convertToAnthropicMessagesPrompt`，OpenAI 转换器为 `convertToOpenAIResponsesInput`。
