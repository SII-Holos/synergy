# 消息组装管线：从落盘消息到模型请求

> 所属：Session 核心重构（issue #281，总纲见 `docs/session-core-redesign.md`）
> 范围：后端。`session/invoke.ts`、`session/message-v2.ts`、`session/llm.ts`、`session/history.ts`、`session/compaction.ts`、`session/plan-mode-user-wrapper.ts`
> 本文写法：每个阶段先描述现状（含代码位置），再给出新设计下的变化。末尾附完整伪代码与字段消费对照。

---

## 0. 分层总览

一次 model call 的输入由四层组装而成，**只有第一层是持久化的**：

```
┌─────────────────────────────────────────────────────────────┐
│ L1 落盘层（事实）      user / assistant 消息 + parts          │  持久化
├─────────────────────────────────────────────────────────────┤
│ L2 有效视图（裁剪）    history 回退事件过滤 → compaction 截断   │  确定性派生
├─────────────────────────────────────────────────────────────┤
│ L3 调用投影（改写）    reminder 包装 → plan-mode 包装 →        │  每次调用临时生成
│                       plugin transform → toModelMessage      │  永不回写
├─────────────────────────────────────────────────────────────┤
│ L4 system 层（拼装）   agent prompt → 分层 systemParts →       │  每次调用临时生成
│                       user.system → plugin transform         │  永不落盘
└─────────────────────────────────────────────────────────────┘
```

不变式（在总纲 I1–I6 基础上补充）：

- **I7（临时拼装）**：L2–L4 均为 L1 的纯函数投影。任何 prompt 脚手架（plan-mode 包装、reminder、recall 内容、system 各层）不落盘；落盘层只记录事实（消息本体）与事实的元数据（如 `injectedContext` 记录"注入过哪些条目"，但不含内容）。
- **I8（调度与内容分离）**：L2 的裁剪只依赖 `rootID` / 回退事件 / compaction 边界；L3/L4 的改写只依赖 `origin` / `includeInContext` / agent 配置。任何一层不得读取另一层专属的字段。

---

## 1. L1 → L2：有效视图

### 1.1 现状

入口 `effectiveCompactedMessages`（`invoke.ts:1745`）：

```
Session.messages({sessionID})
  = SessionHistory.messages                     // history.ts:243
  = rawMessages（按 id 升序全量读取）
    → applyEvents（history.ts:259，过滤 activeRollbacks 的 droppedMessageIDs 集合）
→ filterCompacted（message-v2.ts:945，从新到旧回溯，
   遇到"带 compaction part 且已有完成 summary assistant 的 user 消息"即截断）
```

要点：

- 回退是**软删除**：消息不动，事件（`RollbackEvent.droppedMessageIDs`）在读路径过滤。
- compaction 截断后，摘要 assistant（`summary: true`）留在窗口内，代替被截断的历史。
- 被 prune 的 tool part 在 `MessageV2.parts`（message-v2.ts:919）读取时把 `output` 置空（`state.time.compacted` 存在时）。

### 1.2 新设计

结构不变，两处替换：

1. **回退过滤改为前缀切割**：`RollbackEvent` 通用形式记 `cutMessageID`，`applyEvents` 的谓词从"id ∈ droppedMessageIDs 集合"变为"存在 active 事件使 `msg.id >= cutMessageID`"。`/undo` 的 root 步长与消息级 rewind 共用同一事件与过滤。
2. **rootID 组的原子性由切点选择保证**：cut 点只能落在消息边界上；按 root 边界切时整组消失，按消息级 rewind 切时留下"root 存在、无终止回复"的半任务——这是合法状态（`needsModelCall` 为真但不自启）。

`filterCompacted` 不变。

---

## 2. L2 → 调度决策（谁触发这次 model call）

### 2.1 现状

`invoke.ts:306-344` 内层循环每轮：

1. 从新到旧扫描找 `lastUser`：`role === "user"` 且 `isPromptVisible`（`metadata.promptVisible !== false`）且 `isReplyRequiredUser`（`metadata.noReply !== true`）。
2. `hasTerminalReply({messages, userID: lastUser.id})`：存在 `parentID === lastUser.id` 且 finish 终止性的 assistant 则退出。
3. 排水（三处，见 §3.1）。
4. 创建 assistant 消息，`parentID = lastUser.id`（`invoke.ts:509`）——**parent 漂移的源头**：cortex 通知、compaction continue 都可能成为 lastUser。

### 2.2 新设计

```
R = 最新 isRoot user 消息
needsModelCall(R, msgs) :=
  ∃ user U (U.rootID === R.id) 且
  ¬∃ assistant A (A.rootID === R.id ∧ terminal(A.finish) ∧ A.id > U.id)
```

- assistant 创建时 `rootID = R.id`，恒定。
- `isPromptVisible` 退出调度判断（它是上下文语义，归 `toModelMessage` 的 `includeInContext` 消费）；`isReplyRequiredUser` 删除。
- 谓词基于 L2 有效视图计算（回退后自动正确）。

---

## 3. 排水（inbox → L1 物化）在管线中的位置

### 3.1 现状（三处 + 双缓冲）

| 位置               | 代码                | 内容                                                                                               |
| ------------------ | ------------------- | -------------------------------------------------------------------------------------------------- |
| 每轮 model call 前 | `invoke.ts:384-407` | `drainGuiding` + `drainAgentUpdates`（物化时打 `guided`/`noReply`/`synthetic`）+ legacy user mails |
| 内层循环结束后     | `invoke.ts:922-942` | `peekReady` → 物化 → needsReply 则 `commitReady` + `continue outer`                                |
| loop 完全结束后    | `invoke.ts:946-949` | legacy assistant mails 落盘（孤儿 parentID）                                                       |

### 3.2 新设计（两个排水点 + piggyback）

```
runLoop(R):
  while true:
    materialize(inbox.drain(mode == "steer"))          // ① steer：无条件排水
    if !needsModelCall(R, effectiveView()):
      break                                             // context 不排水，留在 inbox
    materialize(inbox.drain(mode == "context", role == "user"))  // ② context：搭便车
    ... 组装并调用模型 ...

runSession:
  loop 间取 mode == "task" 的队头作为新 R
```

- **顺序敏感**：steer 排水在谓词计算**之前**（steer 有权促成调用）；context 排水在谓词判真**之后**（context 永不单独引发调用）。
- `role === "assistant"` 的 context 投递不经排水点，deliver 时立即落盘（不影响谓词）。
- 物化写入：`rootID = R.id`、`visible`/`origin` 取自 item、messageID 用 item 预分配值（幂等）。**不写任何调度 metadata**。
- 排水读取的是 L2 有效视图对应的 inbox 状态；active rollback 期间 ①② 均冻结（只有 task 可入队不可启动）。

---

## 4. L2 → L3：调用投影（三次改写 + 一次转换）

以下全部作用于 shallow copy（`invoke.ts:542`：复制 message/parts 引用数组、共享大字符串负载），**永不回写**。

### 4.1 reminder 包装

现状（`invoke.ts:545-564`）：step>1 且存在 lastFinished 时，把"晚于 lastFinished 的 user 消息"的 text part（跳过 `ignored`/`synthetic`）包进 `<system-reminder>The user sent the following message...`。

新设计：目标改为**非 root 注入消息**（`!isRoot && origin.type === "user"`，即 steer 进来的用户插话）的 `part.origin === "user"` 文本。语义从"位置启发"（晚于上次完成）变为"身份精确"（就是 mid-run 插话）。cortex/agenda 等非用户 origin 的注入不包装（它们有自己的结构化文本）。

### 4.2 plan-mode 包装

现状（`plan-mode-user-wrapper.ts:53-90`）：session 处于 plan mode 时，对带 `metadata.planModeRequest === true` 的 user 消息，把第一个非 synthetic/ignored text part 原地替换为 `<plan-mode-user-request>` 包装；无文本时前插一个 synthetic 占位 part（仅存在于投影中）。

新设计：判定简化为 `isRoot && origin.type === "user" && planMode`，包装目标为 `part.origin === "user"` 的 text part。`planModeAgent`/`planModeWrapperVersion` 仍留 metadata（plan-mode 私有）。`metadataForUserMessage` 里对 `noReply`/`synthetic`/`source` 的排除条件（`plan-mode-user-wrapper.ts:36-44`）全部替换为 `isRoot` 与 `origin` 判断。

### 4.3 plugin transform

`experimental.chat.messages.transform`（`invoke.ts:566`）位置与语义不变，作用于投影副本。

### 4.4 toModelMessage（L3 → provider 消息）

现状（`message-v2.ts:741-875`）逐条规则：

| 规则                               | 现状依据                                                                                                         | 新设计依据                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 跳过整条消息                       | `!isPromptVisible(msg)`（`promptVisible`/`command.promptVisible` metadata）                                      | `includeInContext === false`                                                                |
| user text part 过滤                | `!part.ignored`（synthetic **不过滤**，进模型）                                                                  | 无过滤（`ignored` 删除；`part.origin` 不影响模型可见性——system 注入文本本来就是给模型看的） |
| user attachment                    | `AttachmentModelPolicy`（summary/content/provider-file/none）+ 历史图片去重（hash，保留最近 `maxHistoryImages`） | 不变                                                                                        |
| assistant 错误消息                 | 有 error 且非"aborted 但有实质内容"→ 整条跳过                                                                    | 不变                                                                                        |
| tool completed                     | `state.time.compacted` 存在 → 输出替换为 `[Old tool result content cleared]`                                     | 不变                                                                                        |
| reasoning/step-start/metadata 清洗 | `modelProviderMetadata` 剥离 provider 专有键                                                                     | 不变                                                                                        |
| 收尾                               | `convertToModelMessages`，过滤纯 step-start 消息                                                                 | 不变                                                                                        |

关键澄清：**`part.origin`（原 `part.synthetic`）与模型上下文无关**——附件展开文本、锚点复述都必须进模型。它只服务于渲染派生（前端）与"找用户原文"（anchor/包装）。上下文维度只有两个开关：message 级 `includeInContext`，attachment 级 `AttachmentModelPolicy`。

### 4.5 步数上限追加

`invoke.ts:727-735`：isLastStep 时在消息尾追加一条 assistant 文本（`MAX_STEPS`）。不变。

---

## 5. L4：system 拼装

### 5.1 现状（保持不变，此处存档以固定契约）

`invoke.ts:604-719` 组装 `systemParts`（分层排序服务于 provider 前缀缓存），`llm.ts:140-160` 最终合成：

```
[0] agent.prompt（或 provider 默认，withPreambleSection）      ← llm.ts
[1] AGENTS.md 等 custom parts                                  ← 稳定，缓存断点
[2] permission context（control profile 编译产物）              ← 半稳定，缓存断点
[3] cortex execution context（delegated_subagent 时）
[4] plan-mode / blueprint-loop 上下文
[5] memory/experience recall（step1 检索，之后读内存 cache）     ← I7：内容不落盘
[6] env block（含时间戳）
[7] git health / coauthor reminder
[8] agenda reminder / cortex reminder / planning reminder
[9] time-context（step1 且有上次完成时间）
[+] user.system（root 上持久化的任务级 system 追加）             ← llm.ts:154
[+] plugin experimental.chat.system.transform
```

### 5.2 新设计的唯一变化

`user.system` 的读取对象从 `lastUser`（会漂移到通知/continue 消息上）改为 **R**（任务 root）。同理 `lastUser.tools`、`lastUser.variant`、`lastUser.agent`、`lastUser.model`、ephemeral tools 的键（`ephemeralToolsByMessage.get(lastUser.id)`）全部改为按 `R.id` 取值——**任务级配置只在 root 上有意义**（总纲 §4.1）。agent/model 继承逻辑（`input.ts:156-174` 的 `isSessionIdentityAnchor` 回溯）删除，替换为 `findLast(isRoot)`。

recall 的缓存键仍是 sessionID，step>1 复用、loop 结束驱逐（`recall.ts:22-33`）不变。

---

## 6. 预算与 compaction 决策

现状（`invoke.ts:737-774`）：`PromptBudgeter.buildPlan`（system + messages + tool definitions 估算，calibration 用最近 assistant 的真实 token 数校准）→ `decide` → `shouldCompact` 时向 `lastUser` 追加 `compaction` part 并 `continue`（下一轮由 LoopJob pre-job 执行 compaction）。

新设计：机制不变，两处替换：

1. compaction part 挂到 **R**（而非漂移的 lastUser）。
2. emergency compaction（`invoke.ts:892-911`，现状新建 user 消息当新 parent）改为注入一条 steer（`rootID = R.id`、`origin: {type:"compaction", detail:"emergency"}`、`visible: false`）并携带 compaction part。
3. compaction 完成后的 auto-continue 同理为 steer 注入（`origin.detail: "auto_continue"`），anchor 文本按 `rootID` 读 R 生成（O(1)，无 fallback 链，见总纲 §7）。

---

## 7. 完整伪代码（新设计）

```ts
async function runSession(sessionID) {
  while (true) {
    const item = await Inbox.nextTask(sessionID)        // FIFO；无则退出
    if (!item) break
    const R = await materializeRoot(item)                // isRoot=true, rootID=id
    await runLoop(sessionID, R)
  }
  finalizeSession()                                      // pendingReply 清理、completionNotice
}

async function runLoop(sessionID, R) {
  let step = 0
  while (true) {
    if (abort.aborted) break
    await materialize(await Inbox.drainSteer(sessionID), R)          // ① steer
    const msgs = await effectiveView(sessionID)                      // L2
    if (!needsModelCall(R, msgs)) break
    step++

    const signals = LoopJob.detectSignals(ctx)                       // compact/error_loop/...
    if (await LoopJob.runPre(ctx) === "stop") break                  // compaction 在此执行
    if (... === "continue") continue

    await materialize(await Inbox.drainContext(sessionID), R)        // ② context 搭便车
    const projected = project(msgs, R)                               // L3：shallow copy
    //   ├─ wrapReminders(projected, R)        非 root user-origin 插话
    //   ├─ wrapPlanMode(projected, R)         R 的 user-origin 正文
    //   └─ Plugin.transform(projected)
    const modelMessages = toModelMessage(projected, { maxHistoryImages })
    const system = assembleSystem(R, step)                           // L4，读 R.system/R.tools
    const plan = PromptBudgeter.buildPlan({ system, messages: modelMessages, tools })
    if (PromptBudgeter.decide(plan).shouldCompact) {
      await appendCompactionPart(R, { auto: true }); continue
    }
    const assistant = createAssistant({ rootID: R.id })              // 恒定，不漂移
    await processor.process({ user: R, system, messages: plan.messages, ... })
  }
}
```

---

## 8. 字段消费对照（本管线内）

| 消费点                                                        | 现状读取                                  | 新设计读取                                                 |
| ------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| L2 回退过滤                                                   | `droppedMessageIDs` 集合                  | `cutMessageID` 前缀比较                                    |
| 调度选 parent                                                 | `metadata.noReply` + `isPromptVisible`    | `isRoot` + `needsModelCall`                                |
| assistant 归属                                                | `parentID = lastUser.id`（漂移）          | `rootID = R.id`（恒定）                                    |
| reminder 包装目标                                             | 位置启发 + `!ignored && !synthetic`       | `!isRoot && origin.type==="user"` + `part.origin==="user"` |
| plan-mode 包装目标                                            | `planModeRequest` metadata + part 双 flag | `isRoot && origin.type==="user"` + `part.origin==="user"`  |
| toModelMessage 整条跳过                                       | `promptVisible` metadata                  | `includeInContext`                                         |
| toModelMessage part 过滤                                      | `part.ignored`（死代码）                  | 无                                                         |
| 任务级配置（system/tools/variant/agent/model/ephemeralTools） | `lastUser.*`（可能漂移）                  | `R.*`                                                      |
| anchor 文本                                                   | 三级 fallback + metadata 接力             | 按 `rootID` 读 R 的 `part.origin==="user"` 文本            |
| compaction part 挂载点                                        | lastUser（可能是通知）                    | R                                                          |

---

## 9. 边界情况

1. **R 被 compaction 截出窗口**：anchor 按 rootID 从存储读，不依赖窗口（总纲 §7）；`needsModelCall` 只比较 id 与 finish，不需要 R 的 parts 在窗口内。
2. **半任务（rewind 切中间 / fork 截断）**：谓词为真但不自启（resume 禁自启原则）；下一条 steer 可续跑，下一条 task 开新组。
3. **R 无文本**（agenda 触发、纯附件）：anchor 退 `R.summary.title`；plan-mode 投影用占位 part（仅投影内）。
4. **步内注入的可见性**：steer 在 ① 物化后立即进入本轮 L2 视图；context 在 ② 物化，进入**本轮**调用（搭的就是这班车）。
5. **外部代理适配器**：无 L3/L4 管线（单次 process），steer 降级为 task 在 deliver 层完成，本管线不感知。
6. **abort 时机**：①② 物化与 model call 之间 abort——已物化消息保留（事实层），未消费的 inbox 项按 §5.3 规则处理（steer 丢弃、task 保留）。
