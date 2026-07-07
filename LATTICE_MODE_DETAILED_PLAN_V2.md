# Lattice Mode 详细方案（V2 修订版）

## Summary

不修改、不迁移、不删除现有 superplan 代码。新增独立 Lattice 能力。

Lattice 是一个 session-level 模式，用户可从前端像 Plan Mode 一样开启/关闭，并选择：

- **auto**：全自动。只在第一个 BlueprintLoop 启动前允许询问用户；之后持续推进，不因用户未确认而停。
- **collaborative**：协作。全程允许 question 工具；每次生成好 Blueprint 后进入 review 阶段，必须等前端 Continue 按钮/API 才执行。

Lattice 的持久化规划产物叫 **Pathway**。Pathway 不是 Todo，也不是当前 session 的任务结构；它是 Lattice 专属的顺序 step list + 状态机 + Blueprint 绑定记录。

Lattice 复用现有基座：

- Blueprint note：继续用 `note_write kind:"blueprint"`。
- BlueprintLoop：继续用现有 loop 状态机与 audit/restart 机制执行每个 step。
- 当前 session 执行：复用 BlueprintLoop 的 first prompt 投递 + `SessionManager.deliver`。
- 停下后继续：通过新增的 **Session Continuation Kernel** 接入（见前置重构 B）。

Prompt 必须独立成 `.txt` 文件，按 mode 和 phase 拆开，运行时只做变量填充和拼接。

### 方案范围（明确收敛）

本方案**只覆盖 Lattice mode 本身**，加上两个 V1 硬依赖的前置小重构和一个 BlueprintLoop 最小字段扩展。以下内容明确不在本方案内，留给后续专项：

- 通用 Atomic Loop / loop engineering 的全面抽象（BlueprintRun 概念重命名、统一 service 层全量收编、跨 session/worktree/scope 执行语义）。
- superplan 的任何改动或收编。
- worktree 创建与 merge 编排（字段保留，不实现）。
- research pipeline、release pipeline、channel workflow 等其他 loop 场景。

---

## 前置重构 A：BlueprintLoopService（V1 硬依赖）

**现状问题**：`deliverFirstPrompt`、`resolveBlueprintAgent`、`resolveBlueprintAuditAgent`、`bindSessionToLoop`、start 的失败回滚逻辑全部是 `packages/synergy/src/server/blueprint.ts` 中的私有函数，锁在 HTTP route 里。Lattice 无法复用，除非内部发 HTTP 或复制代码——两者都不可接受。

**改动**：新增 `packages/synergy/src/blueprint/service.ts`，把以下逻辑从 route 抽出（**只搬家，不改行为**，route 改为薄壳调用 service）：

```ts
export namespace BlueprintLoopService {
  // create（含 AlreadyActive 校验、agent 解析、note 关联）
  export async function create(input: CreateInput & { orchestration?: Orchestration }): Promise<Info>

  // armed -> running + bindSessionToLoop + deliverFirstPrompt（含失败回滚为 failed）
  export async function start(scopeID: string, loopID: string, userPrompt?: string): Promise<Info>

  // 组合入口，Lattice 主要用这个
  export async function createAndStart(input: ...): Promise<Info>
}
```

route（`/blueprint/loop` 系列）行为完全不变，仅实现搬迁。现有 blueprint/session 测试作为守护。

---

## 前置重构 B：Session Continuation Kernel（V1 硬依赖）

**现状问题**：`session/blueprint-continuation.ts` 独立订阅 `SessionEvent.Idle`。Lattice 若再独立订阅一份，`blueprint_execution` 阶段 session 同时带有 `session.blueprint.loopID` 和 `session.lattice`，一次 idle 会触发双重唤醒。

**改动**：新增 `packages/synergy/src/session/continuation-kernel.ts`：

```ts
export interface ContinuationPolicy {
  id: string // "blueprint_loop" | "lattice"
  priority: number // 大者先执行，第一个返回 true 的 policy 消费该次 idle
  handle(input: { session: Session.Info; scopeID: string; sessionID: string }): Promise<boolean>
}

export namespace ContinuationKernel {
  export function register(policy: ContinuationPolicy): void
  export function init(): void // 唯一的 SessionEvent.Idle 订阅（ScopedState 模式，同现有实现）
  export async function kick(sessionID: string): Promise<boolean> // 主动触发一次评估（供 route 使用）
}
```

**Kernel 统一执行的公共安全闸**（从现有 BlueprintContinuation 原样提取）：

- session 存在且未 archived；
- session 当前不在 running（idle 事件本身保证，kick 时需检查）；
- 无 active Cortex work（queued/running）；
- 最新 reply-required user message 已有 terminal assistant 回复，且该 assistant 无 error。

**Kernel 统一的防重复投递**：以 `sessionID + policyID + 最新 terminal assistant messageID` 为 key，同一个 terminal assistant 之后，同一 policy 只允许消费一次 idle。内存态即可（per-scope Map），进程重启后 key 丢失可接受（最坏多投一次，policy 自身逻辑幂等兜底）。

**迁移**：`BlueprintContinuation` 迁为 `BlueprintContinuationPolicy`（priority 100），行为不变（判断 loop status === "running" 则投递现有 continuation prompt）。现有 `BlueprintContinuation.init()` 调用点（`session/invoke.ts` loop 入口）替换为 `ContinuationKernel.init()`。

**所有权仲裁规则**（不搞复杂 priority 表，一条自然规则）：

- session 有 active BlueprintLoop 且 status 为 `running` → BlueprintContinuationPolicy 独占本次 idle；
- 否则 → LatticePolicy 接手（它自己再按 run status / phase 判断）；
- LatticePolicy 在 `blueprint_execution` 且绑定 loop 存活时显式 return false；若 phase 是 `blueprint_execution` 但绑定 loop 已丢失或异常终止，LatticePolicy 可接管做恢复（kernel 带来的免费容错）。

**continuation 投递模式定稿：`task`**（新 root turn）。与现有 BlueprintContinuation 行为一致：每个 phase 的推进是干净的 turn，compaction anchor、agent/model 解析都独立可控。不使用 `steer`/`context`。

---

## 前置重构 C：BlueprintLoop `orchestration` 字段 + finish 邮件定制（V1 硬依赖，最小扩展）

**现状问题 1**：`blueprint_loop_finish(completed)` 会给执行 session 投一封完成邮件，文案是"总结完成情况给用户、然后停下"。这与 Lattice result_analysis 要求的"分析结果、更新 Pathway、继续推进"直接矛盾，会造成一个废轮次。

**现状问题 2**：finish 工具当前**先投递完成邮件、后 updateStatus(completed)**，Lattice bridge 依赖 terminal 事件推进 phase，会产生"邮件已开始处理但 phase 还是 blueprint_execution"的竞态。

**改动**：

1. `blueprint/types.ts` 的 `Info` 增加可选字段：

```ts
orchestration: z.object({
  kind: z.literal("lattice"),
  runID: z.string(),
}).optional()
```

2. `blueprint_loop_finish` 对带 `orchestration.kind === "lattice"` 的 loop：
   - **先 `updateStatus`（触发 bus 事件、bridge 推进 phase），后投递邮件**，消除竞态；
   - completed 邮件文案改为 Lattice 语义：告知 audit summary，并指示"你处于 Lattice result_analysis 阶段：分析本 step 结果，通过 pathway_patch 更新 Pathway，然后继续推进；不要向用户做收尾总结后停下"。这封邮件本身就是 result_analysis 的 kick-off（completed 路径不需要额外 continuation）；
   - failed 路径行为不变（abort session → idle → kernel 唤醒进入 result_analysis）。
3. 无 orchestration 的 loop 行为完全不变。

---

## Core Model

新增目录：

```text
packages/synergy/src/lattice/
packages/synergy/src/lattice/types.ts
packages/synergy/src/lattice/store.ts
packages/synergy/src/lattice/event.ts
packages/synergy/src/lattice/prompt.ts
packages/synergy/src/lattice/policy.ts          // LatticePolicy（continuation + 执行启动，见 Kernel 章节）
packages/synergy/src/lattice/bridge.ts          // BlueprintLoop terminal event -> Pathway/phase 推进
packages/synergy/src/lattice/prompt/*.txt
packages/synergy/src/server/lattice.ts
```

不要改 `packages/synergy/src/superplan/*`。

核心类型：

```ts
type LatticeMode = "auto" | "collaborative"

type LatticePhase =
  | "initial_planning"
  | "step_blueprinting"
  | "blueprint_review" // 仅 collaborative
  | "blueprint_execution"
  | "result_analysis"

type LatticeRunStatus = "active" | "paused" | "completed" | "failed" | "cancelled"

type PathwayStepStatus =
  | "pending"
  | "ready"
  | "blueprinting"
  | "reviewing" // 仅 collaborative review 期间
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
```

**LatticeRun 存储**：

- id
- scopeID
- sessionID
- mode
- **maxModelCalls**: number（Synergy 内部 LLM call 步数上限；0 表示无限。命名刻意避开 "steps"，与 Pathway step、agent.steps 区分）
- modelCallCount: number（批量 flush 更新，见 Session Integration）
- status
- statusReason?: string（paused/failed 时的结构化原因，如 `"model_call_budget_exhausted"`、`"blueprint_loop_cancelled"`、`"user_exit"`）
- phase
- goal
- currentStepID?
- firstBlueprintStarted: boolean
- assumptions: string[]
- pathway: PathwayStep[]（数组顺序即执行顺序）
- time.created, time.updated, time.paused?, time.completed?

**注意：events 不内嵌在 run 文档里。** run 会被频繁 `Storage.update` 整体重写，内嵌 events 数组导致写放大。照抄 `SuperPlanStore.appendEvent` 的独立存储模式。

**存储路径**（`storage/path.ts` 新增）：

```ts
latticeRun = (scopeID, sessionID) => ["lattice", "runs", scopeID, sessionID]
latticeEventsRoot = (scopeID, sessionID) => ["lattice", "events", scopeID, sessionID]
latticeEvent = (scopeID, sessionID, eventID) => [...latticeEventsRoot, eventID]
```

**每个 session 有且只能有一套 Lattice 数据**：store 直接以 sessionID 为 key（不是独立 runID key），天然保证唯一性，且 bridge 收到 loop terminal event 时可用 `loop.sessionID` 一次读定位 run（O(1)，无需扫描）。run 内部仍保留 `id` 字段用于 API 与事件引用。同一 session 重新开始 Lattice 时是重置/替换这套数据；历史只保留在该 run 的 events/summary 中。

**PathwayStep 存储**：

- id
- title
- objective
- status
- acceptanceCriteria: string[]
- assumptions: string[]
- blueprintNoteID?
- blueprintVersion?
- blueprintLoopID?（仅记录当前/最后一次 loop；被 pause cancel 掉的历史 loopID 记入 events）
- resultSummary?
- failureReason?
- resultCommit?（预留，V1 不用）
- worktreeID?（预留，V1 不用）
- addressesFailedStepIDs?: string[]
- time.created, time.updated, time.started?, time.completed?

**Session metadata 新增**（`session/types.ts`，与 `superplan`、`blueprint` 字段并列）：

```ts
lattice?: {
  runID: string
  mode: "auto" | "collaborative"
}
```

`session.lattice` 的语义 = 该 session 处于 Lattice 模式（prompt 注入、工具可见性依据）。run 的 active/paused 由 `run.status` 单一裁决，continuation 只看 `run.status`。这允许"run 已 paused 但 session.lattice 保留"的状态（loop 被外部 cancel 时的 UI 恢复入口，见状态机）。

---

## State Machine

固定 phase。**phase 只能由 backend 的确定 transition 更新**；agent-facing 工具不暴露 phase transition 能力。

### 自动 transition 总表

| 触发                                                                                                   | 条件                                                                  | 结果                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pathway_patch` 写入有效初始 Pathway                                                                   | phase = initial_planning，≥1 个 ready/pending step                    | currentStepID = 顺序中第一个 ready step；phase → step_blueprinting                                                                                                 |
| `pathway_patch` 绑定当前 step 的 blueprintNoteID                                                       | phase = step_blueprinting                                             | collaborative：step → reviewing，phase → blueprint_review；auto：phase → blueprint_execution（step 保持 ready，**loop 不在此处启动**）                             |
| Kernel LatticePolicy 在 idle 时发现 phase = blueprint_execution、当前 step 已绑定 note、无 active loop | 公共安全闸通过                                                        | `BlueprintLoopService.createAndStart`（orchestration = lattice）；step → running；首次时置 firstBlueprintStarted = true                                            |
| 前端 `POST /lattice/run/:id/continue`                                                                  | collaborative + blueprint_review + 已绑定                             | 同步 `createAndStart`（可带 userPrompt）；step → running；phase → blueprint_execution                                                                              |
| Bridge 收到 loop terminal event：completed                                                             | run active                                                            | step → completed（resultSummary 取 audit summary）；phase → result_analysis                                                                                        |
| Bridge：failed                                                                                         | run active                                                            | step → failed；phase → result_analysis                                                                                                                             |
| Bridge：cancelled（用户从 UI cancel loop）                                                             | —                                                                     | step → ready（清除 blueprintLoopID，events 记录）；run → paused（statusReason = blueprint_loop_cancelled）；**保留 session.lattice**，UI 显示 paused + Resume 入口 |
| Bridge：任意 terminal event 且 run 已 paused                                                           | —                                                                     | 只记录 step 结果与 event，不推进 phase、不触发 continuation                                                                                                        |
| result_analysis 中 `pathway_patch` 更新后                                                              | 存在下一个 ready step 且失败 step（若有）已被 recovery step 关联      | currentStepID = 下一个 ready step；phase → step_blueprinting                                                                                                       |
| result_analysis 中 `pathway_patch` 更新后                                                              | 无剩余可执行 step，且无未被 addressesFailedStepIDs 覆盖的 failed step | run → completed                                                                                                                                                    |

**auto 模式 loop 启动为什么走 kernel（idle 时）而不是 pathway_patch 同步启动**：pathway_patch 在 agent turn 中间执行，同步 start 会让 first prompt 因 session running 进 inbox 排队，loop 状态已是 running 而 session 还在收尾 planning 语境——状态偏差且 turn 边界脏。挪到 idle 后由 kernel 统一启动，turn 边界干净，且**同一机制天然覆盖 pause→resume 的重启**（resume 后 phase = blueprint_execution + step 已绑定 + 无 active loop → kernel 重新 createAndStart，自动绕开 `LoopError.AlreadyActive`，因为 pause 已 cancel 旧 loop）。

### 各 phase 定义

#### initial_planning

- 目标：从用户高层需求生成初始 Pathway。
- 允许：调查（只读）、询问、写 Pathway。
- 不允许：写项目文件、启动 BlueprintLoop。
- 输出：至少一个 ready/pending step，按预期执行顺序排列。

#### step_blueprinting

- 目标：为当前 ready step 创建或更新一个 decision-complete 的 Blueprint note。
- 允许：读 Pathway、读上下文、创建/编辑 Blueprint note。
- 输出：当前 step 绑定 blueprintNoteID（通过 pathway_patch）。
- auto：绑定后 backend 置 phase = blueprint_execution，loop 由 kernel 在 idle 时启动。
- collaborative：绑定后进入 blueprint_review。

#### blueprint_review（仅 collaborative）

- 目标：用户和 agent 讨论当前 Blueprint。
- 普通用户消息都是讨论，不算继续执行。
- 允许：question、读写当前 Blueprint、修改未执行的 future steps。
- 禁止：启动 BlueprintLoop（**review 期间不创建任何 armed loop**，避免误触发和 `blueprintModeLocked` UI 锁死；loop 在 Continue 时才 create+start）。
- 退出方式：只能通过前端 Continue 按钮/API。continuation 在此 phase 永不 fire。

#### blueprint_execution

- 目标：运行当前 step 的 BlueprintLoop（`runMode: "current"`，orchestration = lattice）。
- Lattice 不重新实现执行器；BlueprintLoop 自己负责执行、audit、restart/finish，其间 idle 由 BlueprintContinuationPolicy 独占。
- 此阶段 pathway_patch 禁止修改当前 running step。
- Lattice prompt 强调：“你当前正在执行当前 step 绑定的 BlueprintLoop；遵守 BlueprintLoop 指令，Lattice 只负责记录外层状态。”

#### result_analysis

- 目标：分析刚完成/失败的 step，更新 Pathway。
- completed 路径的 kick-off 就是定制后的完成邮件（前置重构 C）；failed 路径由 kernel continuation 唤醒。
- step 完成：冻结 step，检查下一个 ready step。
- step 失败：冻结 failed step，**replan forward**——新增 recovery/replacement step，用 addressesFailedStepIDs 关联失败 step。failed step 永不改回 completed。
- auto：更新完 Pathway 后 backend 自动选下一个 ready step → step_blueprinting，kernel 继续推进。
- collaborative：下一个 Blueprint 生成后照常停在 blueprint_review。
- **竞态兜底**：phase prompt 写明“若发现绑定的 loop 已 terminal 而上下文仍显示 execution 语境，先 pathway_read 确认最新 phase”。

### Run 级终止/暂停语义（定稿）

- 所有目标满足 → **completed**。
- 用户 `POST /lattice/run/:id/cancel` → **cancelled**：同时 cancel 当前 armed/running 的 lattice loop，清除 session.lattice。cancel 是明确放弃。
- 用户退出 Lattice 模式（`enabled:false`）→ **paused**，且**顺手 cancel 当前 loop**：
  - 若当前 step 处于 running：cancel 其 BlueprintLoop，step 回退为 ready（保留 blueprintNoteID 绑定，清除 blueprintLoopID，events 记录被 cancel 的 loopID）；
  - run.status → paused（statusReason = user_exit），清除 session.lattice；
  - 不删除 LatticeRun、不清空 Pathway；同一 session 下次打开 Lattice dialog 时展示这套 paused 数据，供 Continue / Restart。
  - 用户先 abort 再退出同样走此语义；abort 不是删除也不是 restart。
- 用户从 UI 直接 cancel 底层 loop（未退出 Lattice）→ run paused（statusReason = blueprint_loop_cancelled），**保留 session.lattice**，UI 显示 paused 状态与 Resume 入口。
- 预算耗尽（modelCallCount ≥ maxModelCalls > 0）→ run **paused**（statusReason = model_call_budget_exhausted），发事件，前端明确展示；用户可在 dialog 提高预算后 continue。不静默停住，也不判 failed。
- 系统不可恢复失败 → **failed**。

### Pathway 不可变规则

- completed/failed step：不可删除、不可改 objective、不可改 Blueprint 绑定、不可从历史顺序中移除或重排。
- cancelled step：同上按 terminal 处理。
- 未执行 step：可拆分、合并、取消、重排，但不能改写 terminal 历史。
- **pause 导致的回退不算 terminal**：running → ready 是 backend 的 pause 副作用，不违反不可变规则（loop 取消记录进 events 审计）。

---

## Resume 语义（enabled:true + action: "continue"）

1. run.status → active，statusReason 清除，写回 session.lattice。
2. phase 重算：
   - currentStep 存在且已绑定 blueprintNoteID：auto → blueprint_execution（等 kernel 重启 loop）；collaborative → blueprint_review；
   - currentStep 存在未绑定 → step_blueprinting；
   - 无 currentStep → 按 Pathway 选下一个 ready step 进 step_blueprinting；Pathway 为空 → initial_planning。
3. **route 最后调用 `ContinuationKernel.kick(sessionID)`**：resume 时 session 是 idle 的，不会再有 Idle 事件自然到来，必须主动踢一脚（启动 loop 或投递 continuation prompt）。

Restart（action: "restart"）：重置/替换该 session 的唯一 LatticeRun，phase = initial_planning，旧数据仅保留为 events 归档（V1 允许直接覆盖）。

---

## Kernel 中的 LatticePolicy（continuation + 执行启动合一）

`lattice/policy.ts` 注册为 `ContinuationPolicy`（id: "lattice"，priority 50）。`handle` 逻辑：

1. `session.lattice` 不存在 → false。
2. 读 run（按 sessionID，O(1)）；status ≠ active → false。
3. flush 待写的 modelCallCount（见 Session Integration）；若 maxModelCalls > 0 且已达上限 → run paused（budget），发事件，return true（消费 idle 但不再推进）。
4. phase = blueprint_review → false（只能 Continue API 退出）。
5. phase = blueprint_execution：
   - 绑定 loop 存活（armed/running/waiting/auditing）→ false（BlueprintContinuationPolicy 的领地；armed 场景见下一条）；
   - 当前 step 已绑定 note 且无 active loop → **执行启动动作**：`BlueprintLoopService.createAndStart`，step → running，首次置 firstBlueprintStarted，return true；
   - loop 已 terminal 但 bridge 未及处理（异常场景）→ 按 bridge 逻辑补偿推进，return true。
6. 其余 active phase（initial_planning / step_blueprinting / result_analysis）→ 投递 continuation synthetic user message（task mode）：
   - 使用 `prompt/continuation.txt`，填充 mode、phase、currentStepID、runID；
   - 核心语义：“你当前不应该停下来；你应该继续推进当前 Lattice 阶段。”
   - mail 带结构化 metadata（source: "lattice_continuation"、runID、phase、stepID）供前端展示与审计。

Kernel 公共闸与防重复投递对本 policy 同样生效（同一 terminal assistant 只消费一次）。

---

## Prompt Design

所有 Lattice prompt 放到 `packages/synergy/src/lattice/prompt/`（bun 文本 import，与现有 `tool/*.txt`、`session/prompt/*.txt` 惯例一致）：

```text
base.txt
mode-auto.txt
mode-collaborative.txt
phase-initial-planning.txt
phase-step-blueprinting.txt
phase-blueprint-review.txt
phase-blueprint-execution.txt
phase-result-analysis.txt
continuation.txt
```

实现（`lattice/prompt.ts`）：

- `LatticePrompt.build(session, run)` 拼接：base + mode + current phase + dynamic context block。
- 注入位置：`session/invoke.ts` 的 Layer 2.5（Plan Mode / BlueprintLoop context 旁）。该层位于缓存断点之后，不破坏前缀缓存，但每个 call 都要付 token，因此**体积必须收紧**。

**dynamic context 内容（代码生成，刻意精简）**：

- run 概要：runID、mode、phase、status、modelCallCount/maxModelCalls；
- current step：完整（title、objective、acceptanceCriteria、绑定的 note/loop、状态）；
- Pathway summary：**仅 step 标题 + 状态 + 顺序位置**，不含全量 objective/acceptanceCriteria；
- 当前 Blueprint note ID / 当前 BlueprintLoop ID（如有）；
- 允许的下一个自动 transition。

**明确砍掉**："Recent relevant user messages from the session" 不注入。这些消息本来就在对话历史里，复制进 system prompt 是纯粹的 token 翻倍并有指代混乱风险。改为在 base.txt 里写一句静态指令：

> 用户在 review 之外的阶段发来的普通消息是对你的指导：把它们纳入后续 Blueprint 和 Pathway 修订，但不要因此停止状态机。

**Prompt 写法要求**：

- 全部第二人称，明确“你当前应该……”。
- 每个 phase 写清楚：当前阶段是什么、你应该做什么、你不能做什么、什么时候进入下一阶段、该调用哪些 Lattice/Blueprint/note 工具、auto/collaborative 差异。
- phase-result-analysis.txt 额外包含竞态兜底句（loop 已 terminal 时先 pathway_read 确认 phase）。
- phase-blueprint-execution.txt 强调服从 BlueprintLoop 指令，Lattice 只记录外层状态。
- mode-auto.txt：持续推进；仅第一个 BlueprintLoop 启动前可问阻塞问题；启动后不得调用 question；失败必须 replan forward。
- mode-collaborative.txt：任何阶段可 question；Blueprint 创建后必须停在 review；只有 Continue API 触发后才执行；用户说“看起来不错”不等于 Continue。

`blueprint-start-user-instruction` 不需要独立 prompt 文件：Continue 带的 userPrompt 直接走 `BlueprintLoopService.start` 现有的 userPrompt 通道（run-specific 契约，执行与 audit 均已消费该字段）。

---

## Tools

新增 Lattice 专属工具，只在 active Lattice session 可见。

### pathway_read

- 读取当前 run、phase、mode、current step、Pathway steps、recent events。
- 无参数（按 ctx.sessionID 定位唯一 run）。
- 所有 Lattice phase 可用。

### pathway_patch

- 创建或更新 Pathway steps；绑定当前 step 的 blueprintNoteID/blueprintVersion。
- 支持全量替换 future Pathway 或 patch 指定 steps。
- 校验（工具层执行，backend transition 依赖其结果）：
  - 禁止修改 terminal steps（completed/failed/cancelled）：objective、status、绑定、顺序均不可变；
  - 禁止在 blueprint_execution 修改当前 running step；
  - 顺序一致性、重复 ID 拒绝；
  - recovery step 可携带 addressesFailedStepIDs。
- patch 成功后 backend 依 transition 总表自动推进 phase（工具本身不改 phase）。

### 工具可见性

统一走现有 choke point：**扩展 `session/tool-mode-policy.ts` 的 `SessionModePolicy`**（增加 lattice 分支；不新建第二层策略），并改 `session/tool-resolver.ts`：

- 非 Lattice session：pathway\_\* 不可见。
- Lattice session：pathway_read 全 phase 可见；pathway_patch 按 phase 显示（blueprint_execution 期间对 running step 只读）。
- auto 且 firstBlueprintStarted === true：question 不可见（或调用时返回 mode diagnostic）。
- collaborative：question 始终可见。
- `tool-resolver.ts` 的 `forcedToolGroups` 增加 `session.lattice` 分支强制 `note` group（planning/review/result phases 需要 note 工具）。
- blueprint_loop_finish 仍只在 active BlueprintLoop session 可用（现有逻辑不动）。

---

## Blueprint Execution Reuse

Lattice 不新建执行框架。执行当前 step 的方式：

- 当前 step 已有 blueprintNoteID；
- kernel（auto/resume）或 Continue route（collaborative）调用 `BlueprintLoopService.createAndStart`：
  - noteID = step.blueprintNoteID
  - sessionID = lattice.sessionID
  - title = step.title
  - description = step.objective
  - runMode = "current"（V1 固定）
  - orchestration = { kind: "lattice", runID }
  - userPrompt = Continue 时用户填写的可选指令（复用现有 start userPrompt 契约）
- Lattice 记录 step.blueprintLoopID，step → running。
- BlueprintLoop 自己负责执行、audit、restart/finish；执行期 idle 由 BlueprintContinuationPolicy 处理。

**Bridge**（`lattice/bridge.ts`，init 时订阅一次）：

- 订阅 `LoopEvent.Updated`，仅处理 `orchestration.kind === "lattice"` 且 status 进入 terminal 的事件（另订阅 Completed/Failed/Cancelled 作为冗余触发均可，幂等处理）；
- 按 `loop.sessionID` 一次读定位 run；
- completed → step completed + phase result_analysis（completed 邮件即 kick-off）；
- failed → step failed + phase result_analysis（kernel continuation 唤醒）；
- cancelled → step ready + run paused（statusReason = blueprint_loop_cancelled）；
- run 已 paused/cancelled 时只记录，不推进、不唤醒；
- 所有处理幂等（重复事件安全）。

V1 明确只做当前 session 执行。worktreeID、resultCommit 字段保留，不做自动 worktree create/merge。

---

## Server APIs

新增 route：`packages/synergy/src/server/lattice.ts`，挂载到 `/lattice`。所有 route 带 OpenAPI metadata，之后运行 `./script/generate.ts` 生成 SDK。

### PUT /lattice/session/:id/mode

```ts
body: {
  enabled: boolean
  mode?: "auto" | "collaborative"
  max_model_calls?: number      // 默认 0 = 无限；语义是 LLM call 预算，不是 Pathway steps
  goal?: string
  action?: "continue" | "restart"
}
```

enabled: true：

- **校验**：session 存在且属当前 scope；若 session 已有 active 非 Lattice BlueprintLoop（`session.blueprint.loopID` 指向 active loop 且无 lattice orchestration）→ 400，后端拒绝，不只靠前端锁。
- 已有 active run → 更新 mode/max_model_calls。
- 有 paused run 且 action = "continue" → 走 Resume 语义（含 `ContinuationKernel.kick`）。
- 有既有数据且 action = "restart" → 重置/替换唯一 LatticeRun，phase = initial_planning。
- 无既有数据 → 创建 LatticeRun，phase = initial_planning。
- 写入 session.lattice；关闭 `session.blueprint.planMode`（Plan Mode 与 Lattice 互斥）。
- 若携带 goal 且为新建/restart：以 task mail 投递 initial planning kick 消息；未携带 goal 则等待用户第一条消息作为 goal（phase prompt 覆盖该情形）。

enabled: false（pause，**顺手 cancel loop**）：

- 若当前有 armed/running 的 lattice loop → cancel 之；当前 running step 回退 ready（保留 note 绑定，清 loopID，events 记录）。
- run → paused（statusReason = user_exit）；清除 session.lattice。
- 不删除 LatticeRun、不清空 Pathway。

### GET /lattice/session/:id

读取该 session 的唯一 Lattice 数据（含 Pathway 进度摘要），用于打开配置 dialog 前展示上次运行状态。不存在则返回空状态。

### GET /lattice/run

list 当前 scope 的 runs（每 session 最多一条）。

### GET /lattice/run/:id

读 run。

### GET /lattice/run/:id/events

读该 run 的事件流（审计/调试/前端时间线）。

### POST /lattice/run/:id/continue

```ts
body: { userPrompt?: string }
```

- 只允许 collaborative + blueprint_review；
- 校验 current step 已绑定 Blueprint；
- 同步 `BlueprintLoopService.createAndStart`（带可选 userPrompt）；
- step → running；phase → blueprint_execution。

### POST /lattice/run/:id/cancel

- cancel run（terminal）；
- 若有 armed/running 的 lattice loop，一并 cancel；
- 清除 session.lattice。

---

## Session Integration

**Session.Info schema**：加 `lattice` 字段（见 Core Model）；session create/update 能保存；system environment 加简短 identity（Lattice run / mode / phase 一行）。

**SessionInvoke prompt assembly**（`session/invoke.ts`）：

- Layer 2.5（Plan Mode / BlueprintLoop context 旁）：session 有 active Lattice run 时调用 `LatticePrompt.build(session, run)` 注入 base/mode/phase/dynamic context。
- BlueprintLoop context 同时存在时照常保留（blueprint_execution 期间两者并存，Lattice prompt 明确让位）。

**modelCallCount（批量 flush，避免热路径写放大）**：

- invoke 的 step 循环中，session 带 active lattice run 时**只递增内存计数器**（per-session Map），不写存储、不发事件；
- flush 时机：turn 结束（loop 退出/idle 前）、LatticePolicy.handle 入口、phase transition 时——一次 `Storage.update` 合并写入，此时才发 `lattice.run.updated`；
- 预算判断在 LatticePolicy 里做（本来就要读 run）。精度损失 = 超限后最多多跑完当前 turn，可接受；
- 进程崩溃丢失未 flush 的计数可接受（预算是软护栏）。

**用户中途输入**：

- 非 blueprint_review：正常成为 task turn；不写入 LatticeRun；base prompt 的静态指令要求 agent 将其纳入指导但不停状态机；
- blueprint_review：就是 Blueprint 讨论，允许停。

---

## Frontend

### Prompt workflow menu

- Plan Mode 同级新增 Lattice 入口。
- 点击 Lattice 打开配置 dialog（不直接进模式）。
- 打开前经 generated SDK 调 `GET /lattice/session/:id`。
- 若存在上一套数据，dialog 顶部展示：status（含 statusReason 的人话文案，如“预算耗尽”）、phase、mode、current step title、**Pathway 进度（已完成 n / 总 m step）**、modelCallCount / maxModelCalls（0 显示 unlimited）、paused/completed/failed/cancelled 时间。
- paused 数据 → 提供 Continue existing Lattice（沿用同一套 Pathway/phase/绑定/计数）与 Restart Lattice；
- 不可继续（completed/failed/cancelled）→ Continue 禁用或隐藏，仍展示状态并允许 Restart。
- dialog 字段：mode（auto/collaborative）、max_model_calls（默认 0 = unlimited，标注“内部模型调用预算，不是计划步数”）。
- 确认后调 `PUT /lattice/session/:id/mode`（action = continue/restart）。
- 开启 Lattice 后 Plan Mode 显示不可用；active BlueprintLoop 时维持现有锁定规则。

### Session UI

- Lattice status chip：mode、phase、current step title、modelCallCount/maxModelCalls；run paused（尤其 statusReason = blueprint_loop_cancelled / budget）时 chip 显示 paused 态并提供 Resume 快捷入口（走 PUT mode continue）。
- Pathway panel：step list、顺序位置、status、绑定的 Blueprint note、failure/replan 关联（addressesFailedStepIDs）。

### collaborative + blueprint_review

- 显示 review banner + 当前 Blueprint note link/title；
- **不创建、不装配任何 armed loop**（普通输入框内容只是讨论，不会触发执行，也不触发 blueprintModeLocked）；
- Continue button 调 `/lattice/run/:id/continue`，旁边提供**可选指令输入框**，映射为 start userPrompt（进入 loop 的 run-specific 契约，执行与 audit 都会消费）。

### 事件同步

- 新增 `lattice.run.created`、`lattice.run.updated`、`lattice.event.appended`（BusEvent.define，自动进 global event stream）；
- `lattice.run.updated` 只在真实 transition / 批量 flush 时发，不随每次 LLM call 发（配合 firehose 约束）；
- 前端通过 global event stream 更新本地状态；route 生成后必须用 generated SDK，不手写 fetch。

---

## Tests

### 前置重构守护

- BlueprintLoopService.create/start/createAndStart 行为与原 route 一致（AlreadyActive、agent 解析、first prompt 投递、失败回滚 failed）。
- ContinuationKernel：公共安全闸逐项生效；防重复 key（同一 terminal assistant 同一 policy 只投一次）；priority 仲裁（blueprint policy 先于 lattice）；BlueprintContinuationPolicy 行为与迁移前一致（现有 continuation 测试通过）。
- orchestration finish：lattice loop 先 updateStatus 后投邮件；邮件文案为 result_analysis 语义；非 lattice loop 行为不变。

### Lattice store / Pathway

- store create/get/update（按 sessionID 唯一；重复创建即替换）。
- events 独立存储、append/list。
- 顺序校验：合法顺序通过、重复 ID 拒绝、terminal steps 不可重排。
- terminal immutability：completed step 不可改 objective/status/order；failed step 不可删除、不可转 completed。
- pause 回退：running step → ready 合法且不触犯 immutability；被 cancel 的 loopID 记入 events。
- replan forward：failed 保持 failed；recovery step 可关联 addressesFailedStepIDs；future 顺序可改而不动 terminal。

### Phase transitions

- 固定 transition 通过、非法 transition 拒绝。
- auto：绑定 note → blueprint_execution（不同步启动 loop）；kernel idle → createAndStart（首次置 firstBlueprintStarted）。
- collaborative：绑定 note → blueprint_review；review 只能 Continue API 退出；review 期间 kernel 不 fire。
- bridge：completed → step completed + result_analysis；failed → step failed + result_analysis；cancelled → step ready + run paused（session.lattice 保留）；run paused 时 terminal event 只记录不推进；重复事件幂等。

### Tool tests

- pathway\_\* 非 Lattice session 不可见。
- pathway_read 全 phase 可见；pathway_patch 在 blueprint_execution 对当前 running step 拒绝。
- auto + firstBlueprintStarted → question 不可见/报 diagnostic；collaborative 全 phase 可用。
- forcedToolGroups：lattice session 强制 note group。
- Blueprint note 写入在 lattice planning/review/result phases 允许；不因存在旧 superplan 而放开。

### Integration

- 开启 Lattice：创建 run、写 session.lattice、关闭 planMode；已有 active 非 lattice loop 时 400。
- 未传 max_model_calls → 存 0；更新 mode 可改 max_model_calls。
- 关闭 Lattice（pause）：cancel 当前 loop、running step 回退 ready、run paused（user_exit）、session.lattice 清除、Pathway 保留。
- 同 session 重进：continue 恢复同套数据 + kernel.kick 生效（loop 重启或 continuation 投递）；restart 重置而非新增第二条 run。
- cancel route：run cancelled + loop cancelled + metadata 清除。
- 预算：modelCallCount 批量 flush；达到非零 maxModelCalls 后 kernel 不再 continuation，run paused（budget），发事件；提高预算后 continue 可恢复。
- auto 全链路：initial prompt → Pathway → Blueprint → kernel 启动 loop（无 review 停顿）→ completed → result_analysis → 下一 step。
- collaborative 全链路：Blueprint → review（idle 不 fire）→ Continue（带 userPrompt 进 loop 契约）→ 执行。
- failure 链路：failed → result_analysis → recovery step（addressesFailedStepIDs）→ 继续。
- continuation：非 review active phase idle 时 fire；review 不 fire；Cortex active 不 fire；同一 terminal assistant 不重复投递。

### Frontend

- workflow menu 显示 Lattice；点击开 dialog；dialog 支持 mode/max_model_calls；有历史数据时展示状态与 Pathway 进度；paused 提供 Continue/Restart；确认后调 generated SDK（enabled/mode/max_model_calls/action）。
- Plan Mode 与 Lattice 互斥。
- status chip 渲染 mode/phase/current step/预算；paused（含 loop 被 cancel、预算耗尽）显示 Resume 入口。
- Pathway panel 渲染 steps 与状态。
- review banner 仅在 collaborative blueprint_review 出现；Continue 调 generated SDK；可选指令进 userPrompt；普通消息不触发 Continue、不出现 armed loop。

### Verification commands

```bash
bun run typecheck
cd packages/synergy && bun test test/lattice
cd packages/synergy && bun test test/blueprint
cd packages/synergy && bun test test/session
cd packages/synergy && bun test test/tool
bun run --cwd packages/app build
./script/generate.ts   # route 变更后生成 SDK
```

---

## 落地顺序

1. **前置重构 A**：BlueprintLoopService 抽取（route 薄壳化，行为不变）。
2. **前置重构 B**：ContinuationKernel + BlueprintContinuationPolicy 迁移（行为不变，测试守护）。
3. **前置重构 C**：BlueprintLoop.orchestration 字段 + finish 工具定制（先 updateStatus 后投邮件 + lattice 文案）。
4. Lattice 后端本体：types/store/event → state machine transitions → bridge → LatticePolicy → pathway 工具 + SessionModePolicy 扩展 + forcedToolGroups → prompt .txt 与注入 → modelCallCount 批量计数。
5. Server routes + OpenAPI + SDK 生成。
6. 前端：dialog / status chip / Pathway panel / review banner + Continue。
7. 测试补全与全量验证。

每步独立可验证；1–3 合并后即可单独出 PR（对现有行为零变化），4–7 为 Lattice 功能 PR。

---

## Assumptions And Defaults

- Pathway 是 Lattice 规划产物的最终命名；预算字段命名为 maxModelCalls（API：max_model_calls），避免与 Pathway step、agent.steps 撞名。
- superplan 保持不动。
- V1 每个 Blueprint 都在当前 session 用现有 BlueprintLoop 机制执行（runMode: "current"）。
- auto 模式只在第一个 BlueprintLoop 启动前允许提问；collaborative 随时可问。
- 运行中唯一的计划内停顿是 collaborative blueprint_review；退出 Lattice 模式 = pause 并 cancel 当前 loop，数据保留供 continue/restart。
- 失败一律 replan forward；failed step 永不改写。
- continuation 一律 task mode（新 root turn）。
- worktree 创建与 merge 编排不在本期，字段预留。
- 本方案范围止于 Lattice mode；通用 Atomic Loop 抽象、跨 worktree 执行、superplan 收编均为后续专项。
