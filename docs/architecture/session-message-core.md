# Session 核心重构设计：消息语义、Loop 与 Inbox

> 状态：设计稿（未实施）。已立项为 issue #281（含撤回/rewind 与 context piggyback 两条补充评论）。
> 细化设计文档集：[`session-message-core/`](./session-message-core/README.md)（01 后端消息组装管线 / 02 前端消息同步与派生 / 03 undo·rewind 统一撤回交互）
> 范围：`packages/synergy/src/session/*`、`packages/synergy/src/cortex|agenda|channel` 的投递侧、`packages/app` / `packages/ui` 的渲染侧

---

## 1. 现状诊断

### 1.1 核心结论

现在的代码把三个**正交**的问题压进了一堆互相纠缠的布尔字段里：

1. **前端是否渲染**（presentation）
2. **是否进入模型上下文**（context）
3. **是否触发/如何参与 loop**（scheduling）

没有任何一个字段单独回答其中一个问题；每个消费方都在用自己的组合启发式去"猜"答案。下面是实际代码里的消费矩阵。

### 1.2 字段消费矩阵（实证）

| 字段                                                              | 写入方                                                                                                                     | 消费方                                                                                                                                                        | 实际承担的语义                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `metadata.synthetic`                                              | `input.ts:619`（当所有 parts 都是 synthetic text 时自动打上）                                                              | `compaction.ts:334`（anchor 排除）、`session.tsx:241/252`（渲染排除）、`plan-mode-user-wrapper.ts`（不包装）                                                  | "整条消息是系统生成的" —— 同时影响渲染、anchor、plan-mode                                                    |
| `part.synthetic`                                                  | `input.ts`（附件展开、MCP resource、Read 注入）、`compaction.ts:549`（continue 消息）、`cortex/manager.ts:519`（完成通知） | `MessageV2.extractText`、`Turn.isSyntheticUser`、`compaction realUserText`、`invoke.ts:549`（reminder 包装跳过）、前端 `session-turn.tsx:414`                 | "这段文本不是用户敲的" —— 但**仍然进模型上下文**（`toModelMessage` 不过滤 synthetic，只过滤 ignored）        |
| `metadata.noReply`                                                | `input.ts:196`（透传 InvokeInput）                                                                                         | `progress.ts:5`（`isReplyRequiredUser`，loop 选 parent 的唯一依据）、`compaction.ts:334`、`input.ts:147` / `session.tsx:228`（identity anchor 排除）          | "不触发独立的 assistant turn" —— 调度语义，却存在 metadata 里                                                |
| `metadata.guided`                                                 | `invoke.ts:186`（guiding 物化时）                                                                                          | `session-turn.tsx:167`（guided-user chip 渲染）、`compaction.ts:334`、identity-anchor 判断                                                                    | "queued 消息被 guide 进当前 run" —— 纯粹是投递路径的痕迹，却永久落库                                         |
| `part.ignored`                                                    | **无任何写入方（全仓 grep 无 `ignored: true`）**                                                                           | `toModelMessage:785`、`extractText`、`realUserText`、reminder/plan-mode 包装、前端 `prompt.ts:36`                                                             | 死代码。"不进模型上下文"这个最重要的维度，唯一的专用字段实际上从未被使用                                     |
| `metadata.promptVisible`                                          | command（action 类）                                                                                                       | `MessageV2.isPromptVisible` → `toModelMessage:746/775`（**跳过整条消息**）、loop 选 lastUser、前端 action 时间线                                              | 真正在干 "不进上下文" 的活的，是这个藏在 command metadata 里的字段                                           |
| `metadata.source` / `sourceSessionID` / `mailbox` / `channelPush` | cortex（`source:"cortex", channelPush:true`）、agenda（`source:"mailbox"`）、blueprint（`blueprint_loop_*`）、session-send | `input.ts:139 isSessionIdentityAnchor`（agent/model 继承黑名单）、**前端 `session.tsx:224` 一份手抄的重复实现**、`special-user-message.tsx`（特殊渲染器选择） | "谁投递的" 被同时用来决定：agent 继承、渲染方式、identity anchor                                             |
| `assistant.parentID`                                              | processor 创建时 = 当前 `lastUser.id`                                                                                      | `hasTerminalReply`、`Turn.collect`、`filterCompacted`                                                                                                         | 本应指向任务 root，实际指向"最近一条 reply-required user"——包括 cortex 通知和 compaction continue 这类伪任务 |

### 1.3 由此产生的连锁复杂度

**a) Loop 的 parent 漂移。** `invoke.ts:320-344` 选 `lastUser` 的标准是 `noReply !== true`。cortex 完成通知投递时 `noReply: false`（`cortex/manager.ts:511`），于是一条系统通知成为新 parent，后续 assistant 全部挂在通知下面；compaction 的 "Continue if you have next steps" 同理成为新 parent。**用户视角的"一个任务"在存储上被切成了多个 turn**，逼出了 `Turn.resolveRealUser` / `resolveUserText` 这类"向前回溯找真实用户"的补丁（`turn.ts:84-113`）。

**b) Compaction anchor 的三级 fallback。** 正因为 parent 可能是通知/continue/guided 消息，`resolveAnchor`（`compaction.ts:352`）只能：先看 parent 是否"合格"（排除 synthetic/noReply/guided）→ 不合格就向前扫全部消息找最近合格的 → 还没有就找 `metadata.compactionAnchor` 携带的历史 anchor。anchor 文本还要跨 compaction 用 metadata 接力（`ANCHOR_METADATA_KEY`）。**如果 parent 恒等于任务 root，这整套机制退化为一次 O(1) 查找。**

**c) 双缓冲 + 三字段冗余的 inbox。** 内存里有 `SessionManager.runtime.mailbox`，磁盘上有 `SessionInbox`，两者并存导致 `invoke.ts` 里有三处 "legacy mails" 的排水逻辑（143-160、402-407、931-948）。`SessionInbox.Item` 的 `kind`（queued_user/guiding/agent_update）、`state`（queued/guiding）、`deliveryTarget`（after_turn/next_model_call）三个字段实际是同一个 bit 的三种写法：`kind==="guiding" ⇔ state==="guiding" ⇔ deliveryTarget==="next_model_call"`。

**d) 前后端逻辑复制。** `isSessionIdentityAnchor` 在 `input.ts:139` 和 `session.tsx:224` 各有一份手抄黑名单（cortex/mailbox/agenda/blueprint*loop*\*/sourceSessionID/guided+noReply），改一处忘一处。前端为了决定"渲染谁"，要同时看 `synthetic`、`guided+noReply`、`source`、`hasSpecialUserMessageRenderer` 四个来源。

**e) 已有未启用的脚手架。** `message-v2.ts:429-436` 的 Base/User schema 已经加了 `visible` / `includeInContext` / `rootID` / `isRoot` 四个可选字段，但**全仓库零消费**（只出现在生成的 SDK 类型里）。方向对了，没接线。

---

## 2. 目标模型

### 2.1 心智模型：串行任务 Loop

```
Session = 串行执行的任务队列
Task    = 1 个 root user message + N 条注入消息 + N 条 assistant message
Loop    = 对一个 Task 的 while(model call) 循环，直到终止性 stop_reason
```

- 每个 session 同时最多一个活跃 loop（现有 `SessionManager.acquire` 语义保留）。
- loop 绑定一个 **root** user message `R`；期间产生的**所有** assistant message 的 `rootID = R.id`。
- loop 中途可以注入消息（user 或 assistant），注入消息 `rootID = R.id`，不改变 loop 归属。
- loop 终止 = 模型输出终止性 `stop_reason` 且没有未消费的注入消息；或用户 abort。
- 下一个 root 只能在当前 loop 结束后启动。

### 2.2 三个正交字段

消息上只保留三个语义字段，每个字段回答且只回答一个问题：

```ts
Base {
  rootID: string        // 调度：属于哪个任务。root 自身 rootID === id
  visible: boolean      // 渲染：前端是否显示（默认 true）。后端永不读它
  // 上下文维度见下
}
User {
  // isRoot 可作为派生（rootID === id），schema 里保留只是为了查询方便
  origin: {             // 溯源：谁产生的。替代 metadata.source/sourceSessionID/mailbox/channelPush/guided 全家桶
    type: "user" | "cortex" | "agenda" | "blueprint" | "channel" | "compaction" | "system" | string
    sessionID?: string
    label?: string
  }
}
TextPart {
  origin?: "user" | "system"   // 替代 part.synthetic："user" = 用户敲的原文
}
```

**上下文（context）维度的处理**：审视全部现有场景后，message 级别"不进上下文"只有一个真实用例——action command 的 `promptVisible:false`。所以：

- message 级：`includeInContext: boolean`（默认 true），只替代 `promptVisible` 这一个场景。`toModelMessage` 只看它。
- part 级：附件已有完备的 `AttachmentModelPolicy`（summary/content/provider-file/none），保留不动；`part.ignored` **直接删除**（无写入方，死代码）。

被删掉的字段及去向：

| 旧字段                                | 去向                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `metadata.synthetic`                  | 删除。渲染上由 `visible:false` 表达；"哪段是用户原文"由 `part.origin` 表达   |
| `part.synthetic`                      | 改名为 `part.origin: "system"`（语义不变，但不再参与 anchor/调度判断）       |
| `metadata.noReply`                    | 删除。调度由 `rootID`（是否 root）表达                                       |
| `metadata.guided`                     | 删除。它只是投递路径，物化后即无意义；渲染 chip 由 "非 root 且 visible" 推出 |
| `part.ignored`                        | 删除（死代码）                                                               |
| `metadata.promptVisible`              | 改为一等字段 `includeInContext`                                              |
| `metadata.source` 等溯源字段          | 收敛为结构化 `origin`                                                        |
| `assistant.parentID`                  | 改名/重定义为 `rootID`，且**恒等于任务 root**，不再漂移                      |
| `metadata.compactionAnchor`           | 删除（anchor 直接由 rootID 查得，见 §4）                                     |
| inbox `kind`/`state`/`deliveryTarget` | 收敛为一个 `mode`（见 §3）                                                   |

`summary`（title/body/diffs）保持不变——它是纯 UI/历史摘要，本来就正交。`compaction` part 保持不变——它是 loop 控制信号，不是消息分类，放在 part 里是合理的。

### 2.3 Loop 判定的新写法

现在 `invoke.ts` 内层循环的驱动逻辑（找 lastUser → `isReplyRequiredUser` → `hasTerminalReply`）替换为：

```
R = 最新的 root user message
loop 继续条件：
  不存在 assistant(rootID=R, terminal finish) 且晚于 属于 R 的最新 user message
```

即：只要 R 之后（含注入）还有未被终止性回复覆盖的 user message，loop 就继续。这一个谓词同时覆盖了现在的 `isReplyRequiredUser`、`hasTerminalReply`、`pendingReply`、`selectResultMessage` 四处判断。`SessionProgress` 整个 namespace 缩为两个函数。

---

## 3. Inbox：单一缓冲 + 单一模式字段

### 3.1 统一投递入口

`SessionManager.mailbox`（内存）与 `SessionInbox`（磁盘）合并为一个持久化 inbox（保留磁盘持久化，崩溃可恢复；内存 mailbox 删除，`invoke.ts` 三处 legacy 排水逻辑随之删除）。

所有想进入 session 的消息走同一个入口：

```ts
Inbox.deliver({
  sessionID,
  message: { role, parts, agent?, model?, summary?, origin, visible? },
  mode: "task" | "steer" | "context",
})
```

三种 mode 的精确语义（这是整个设计的调度核心）：

| mode      | isRoot | drain 时机                                    | session idle 时                                          | 典型来源                                                                         |
| --------- | ------ | --------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `task`    | true   | 当前 loop **结束后**，作为新 root 启动新 loop | 立即启动 loop                                            | 用户新消息、agenda 定时任务、channel push、blueprint loop start                  |
| `steer`   | false  | 当前 loop **下一次 model call 前**            | 唤醒：以最近一个 root 为 R 续跑 loop（assistant 仍挂 R） | 用户 guide、cortex 后台任务完成通知、compaction auto-continue、agenda 提醒类     |
| `context` | false  | 同 steer                                      | **不唤醒**，静默落库，下次 loop 自然带上                 | 纯上下文注入（现在的 `noReply:true` invoke）、session-send 的 assistant 角色投递 |

派生关系：`mode === "task" ⇔ isRoot`；`steer` 与 `context` 的唯一区别是 idle 时是否唤醒。不再有 `kind`/`state`/`deliveryTarget` 三份冗余。

**Guide 操作** = 把 inbox 里一个 `task` item 改成 `steer`，一行状态翻转，不再产生 `guided`/`noReply` metadata。

**Cortex 完成通知**：保留现有 waiter 优先路径（`cortex/manager.ts:436`，父 loop 正在 `task` 工具上等待时直接给 waiter、跳过投递）；否则投 `steer`。这修正了现状中通知以 `noReply:false` 成为新 parent 的问题——通知永远不再开新任务，只是唤醒/汇入上一个任务。若父 session idle 且用户希望通知开新任务（例如通知型 agent），由投递方显式选 `task`，而不是靠 metadata 组合猜。

### 3.2 Loop 骨架（伪代码）

```
async function runSession(sessionID):
  while (item = inbox.nextTask()):            // 串行任务队列
    R = materialize(item)                      // 落库 root
    await runLoop(R)

async function runLoop(R):
  while true:
    materialize(inbox.drainNonTask())          // steer + context，rootID = R.id
    msgs = filterCompacted(messages)
    if !needsModelCall(R, msgs): break         // §2.3 谓词
    signals = LoopJob.detect(...)              // compaction / error_loop / prune 机制保留
    if pre-jobs 返回 stop/continue: 照旧
    assistant = process(model, msgs)           // assistant.rootID = R.id，恒定
  // loop 结束；外层 while 取下一个 task
```

与现状的差异集中在两点：`lastUser` 的漂移消失（parent 恒为 R）；排水点从"三处、按 kind 分流、peek-then-commit 混合 legacy mail"收敛为两处（task 在任务间、非 task 在每次 model call 前），peek-then-commit 的崩溃安全语义保留。

### 3.3 idle 时收到 steer 的续跑边界

steer 唤醒的 loop 与普通 loop 完全同构：R 不变，模型看到新注入的消息，回复后输出 stop 即结束。不需要特殊"续跑"状态。风险是模型对通知无话可说时会产生一条很短的 assistant 消息——这是可接受的，且与现状（通知触发完整新 turn）相比只轻不重。

---

## 4. Compaction：anchor 归一为 rootID 查找

- **anchor 解析**：`resolveAnchor(R) = R 的 parts 中 origin=="user" 的 text`，找不到文本（纯附件/agenda 触发的任务）时退到 `R.summary.title`。删除三级 fallback、删除 `isAnchorEligibleUser` 启发式、删除 `compactionAnchor` metadata 接力。因为 R 是持久化消息，跨多次 compaction 依然可以按 `rootID` 直接读到——**不依赖它还在上下文窗口里**。
- **auto-continue**："Continue if you have next steps" + anchor 文本作为一条 `steer` 注入（`rootID = R.id`，`origin: {type:"compaction"}`，`visible: false`）。它不再成为新 parent，turn 不再断裂，`Turn.resolveRealUser` 这类回溯补丁可删。
- **emergency compaction**（`invoke.ts:892-911`）：同样从"创建新 user message 当新 parent"改为注入 steer + compaction part。
- **有效视图裁剪**：`filterCompacted` 以最新完成的 compaction summary assistant 作为截断点；保留任务 root R、已完成的 compaction summaries（较旧 summary 标记 `includeInContext:false` 仅供调度计数）、以及最新 summary 之后的新消息。这样 root 继续承担任务归属，summary 承担上下文压缩边界。
- prune、mechanical fallback、`compaction_recovery` part 全部机制不变。

---

## 5. 前端：只读 visible + origin

### 5.1 渲染规则（完整）

```
role == "assistant"                    → 照旧按 turn 渲染
role == "user":
  visible == false                     → 不渲染（debug inspector 可看）
  isRoot (rootID === id)               → turn 头（现在的 user bubble）
  !isRoot                              → turn 内 inline chip（复用现有 guided-user 渲染，
                                          chip 样式/图标由 origin.type 决定）
```

特殊渲染器（`special-user-message.tsx` 的 blueprint chip 等）改为按 `origin.type` 分发，与 visible 正交：**产生方决定可见性，前端只决定怎么画**。例如 cortex 通知按你的期望设 `visible:false` 彻底不渲染；如果将来想显示成小 chip，改投递方一行（`visible:true`）即可，前端不用动。

### 5.2 删除的前端逻辑

- `session.tsx:224` 的 `isSessionIdentityAnchor` 手抄黑名单：composer 的 agent/model 回填改为"最近一个 root 的 agent/model"，一次 `findLast(isRoot)`。
- `userMessages` / `renderableUserMessages` 两个 memo 的四重条件（synthetic/guided/identity-anchor/special-renderer）：收敛为 `visible && isRoot` 与 `visible` 两个过滤。
- `session-turn.tsx` 的顺序扫描 + `isSyntheticUser` 启发式分组：turn 分组 = `groupBy(rootID)`。
- `utils/prompt.ts:36` 的 `!part.synthetic && !part.ignored`：改为 `part.origin !== "system"`。

后端同步删除 `input.ts:139 isSessionIdentityAnchor`（agent 继承同样改读最近 root）。

---

## 6. 场景推演（edge cases）

| #   | 场景                                        | 现状                                                                          | 新模型                                                                                                                                                                                              |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 用户发起新消息（idle）                      | invoke → createUserMessage → loop                                             | `task` → 立即成为 R，启动 loop                                                                                                                                                                      |
| 2   | 用户在 running 时发消息                     | inbox `queued_user`，turn 后 peek-commit                                      | `task`，当前 loop 结束后作为新 R。串行语义不变                                                                                                                                                      |
| 3   | 用户 guide 排队消息进当前 run               | kind→guiding + 物化时打 `guided+noReply`                                      | item 的 mode 翻成 `steer`；物化后就是一条普通非 root 消息                                                                                                                                           |
| 4   | cortex 子代理完成，父在 task 工具上等待     | waiter 直接收，跳过 mail                                                      | 不变                                                                                                                                                                                                |
| 5   | cortex 完成，父 loop 在跑（未等待）         | `agent_update` → drainAgentUpdates → guiding 物化（synthetic+guided+noReply） | `steer`，下次 model call 前注入                                                                                                                                                                     |
| 6   | cortex 完成，父 idle                        | mail `noReply:false` → 通知成为新 parent，开新 turn                           | `steer` 唤醒，R 不变，assistant 仍挂原任务                                                                                                                                                          |
| 7   | 子代理 session 自身                         | 子 session 首条消息即其 root；`session.parentID` 管层级                       | 不变（session 层级与消息 rootID 无关）                                                                                                                                                              |
| 8   | agenda 定时唤醒                             | deliver `source:"mailbox"`，noReply 未设 → 触发回复                           | agenda item 配置决定 `task`（默认，新任务）或 `steer`（提醒汇入）                                                                                                                                   |
| 9   | blueprint loop start/continuation/restart   | `source:"blueprint_loop_*"` + identity-anchor 黑名单 + 前端特判               | `task`，`origin:{type:"blueprint"}`，特殊渲染按 origin 分发                                                                                                                                         |
| 10  | channel push（飞书等）                      | `metadata.channelPush` 层层透传                                               | `task`，`origin:{type:"channel"}`；assistant 回写渠道的判断改读 R.origin                                                                                                                            |
| 11  | session_send role=user / assistant          | deliver user mail / 孤儿 parentID 的 assistant mail                           | role=user → `task` 或 `steer`（工具参数暴露）；role=assistant → `context`（落库为 assistant，rootID=最近 root）                                                                                     |
| 12  | compaction auto-continue / emergency        | 新 user message 成为新 parent + anchor metadata 接力                          | `steer` 注入，见 §4                                                                                                                                                                                 |
| 13  | `noReply:true` 的 invoke（静默写上下文）    | 写消息、置 pendingReply、不 loop                                              | `context`                                                                                                                                                                                           |
| 14  | attachment 展开（Read 注入的文本）          | 多个 `part.synthetic` text part                                               | 同一条消息内 `part.origin:"system"`，渲染/包装语义不变                                                                                                                                              |
| 15  | plan-mode 包装                              | 看 `planModeRequest` metadata + 跳过 synthetic/ignored part                   | 只包 root 的 `origin:"user"` text part；`planMode*` 保留为 plan-mode 私有 metadata                                                                                                                  |
| 16  | step>1 的 reminder 包装（`invoke.ts:545`）  | 跳过 ignored/synthetic part                                                   | 包"晚于 lastFinished 的非 root user 消息"的 `origin:"user"` part —— 语义更准确（本来就是给注入消息加的提醒）                                                                                        |
| 17  | 用户 abort                                  | 杀当前 loop；queued 项残留                                                    | abort 终止当前 loop 并**丢弃该 loop 的 pending steer**（steer 是对已死任务的引导），保留 pending task 但不自动启动（abort 表达"停下"意图，下次用户消息或显式 resume 再排水）。这是行为决策点，见 §8 |
| 18  | external agent（claude-code/codex adapter） | 单次 process 后 break                                                         | 不变；steer 对 external agent 退化为下一次 task（adapter 无 mid-run 注入能力），投递层按 agent 能力降级                                                                                             |
| 19  | 崩溃恢复 `resumePending`                    | 依赖 session.pendingReply + 回扫                                              | `pendingReply` 可由 §2.3 谓词派生；session 上保留一份缓存字段仅作索引                                                                                                                               |
| 20  | 多模型/多 agent 切换                        | lastUser 决定 agent/model，通知类消息靠黑名单排除                             | agent/model 只在 root 上有意义；注入消息不带（或带了也忽略），继承自 R                                                                                                                              |

---

## 7. 迁移策略

Schema 脚手架（`visible`/`includeInContext`/`rootID`/`isRoot`）已在 `message-v2.ts` 就位，SDK 类型已生成。建议三阶段：

**Phase 1 — 双写（无行为变化）**

- 所有消息创建点写入新字段：`rootID`（root 自指；assistant 与注入消息指 R）、`visible`、`origin`、part `origin`。
- 旧字段照写，所有消费逻辑不动。
- `session/migration.ts` 增加读时迁移，旧消息按下表推导：
  - user：`noReply===true || guided===true` → 非 root；否则若 `Turn.isSyntheticUser` 为真也非 root；rootID = 向前最近的 root（无则自指）
  - `metadata.synthetic===true` 且无特殊渲染器 → `visible:false`；`source` 有特殊渲染器 → `visible:true`
  - assistant：`rootID = resolveRealUser(parentID)`（用现有回溯逻辑一次性算对，之后就再也不用回溯了）
  - `part.synthetic` → `origin:"system"`；`part.ignored` 丢弃
  - `metadata.source/...` → 结构化 `origin`

**Phase 2 — 消费侧切换（每步可独立验证/回滚）**
按依赖从叶到根：① compaction anchor（收益最大、面最小）→ ② 前端渲染与 composer 继承 → ③ Turn/digest/experience-encoder 分组 → ④ loop 判定与 processor parentID → ⑤ inbox 合并（删内存 mailbox 与 legacy 排水）。

**Phase 3 — 清理**
删除旧字段写入、两份 `isSessionIdentityAnchor`、`Turn.resolveRealUser/resolveUserText`、anchor fallback 链、`SessionProgress` 冗余、`kind/state/deliveryTarget`。SDK 重新生成。

测试锚点：`packages/synergy/test` 已有 compaction/turn/inbox 相关用例；Phase 1 结束时应新增"新旧字段推导一致性"快照测试（对存量 fixture 会话跑迁移，断言派生结果与现有各消费方的判定一致），作为 Phase 2 每步切换的回归网。

---

## 8. 待决问题（需要拍板）

1. **abort 后 pending task 是否自动启动**：§6#17 建议不自动。反方观点：channel 场景下用户 abort 一个任务不应吞掉排队的另一条渠道消息。可折中为"user 来源的 task 保留并自动启动，abort 只吞 steer"。
2. **steer 唤醒 idle session 的成本**：每条 cortex 通知都会触发一次真实 model call。现状其实一样（noReply:false），但重构时可以顺手加"合并窗口"（idle 唤醒前等 N 秒攒批 steer），属可选优化。
3. **`origin.type` 的枚举收敛**：建议先开放 string 兼容插件，核心类型（user/cortex/agenda/blueprint/channel/compaction/system）进类型联合。
4. **assistant 注入消息（session-send role=assistant）的 rootID**：挂最近 root（本文档方案）还是允许孤儿？挂 root 让 turn 分组无特例，倾向前者。
5. **`isRoot` 字段是否物理存储**：`rootID === id` 可派生，但存一份便于存储层按前缀扫 root。倾向存（schema 已有）。

---

## 9. 收益清单

- anchor：3 级 fallback + metadata 接力 → 1 次按 `rootID` 读取。
- inbox：双缓冲、3 个冗余字段、3 处排水 → 单缓冲、1 个 mode、2 个排水点。
- 消息分类：7 个交叉布尔/metadata（synthetic×2、noReply、guided、ignored、promptVisible、source 家族）→ 3 个正交字段 + 1 个 part 级 origin。
- 前后端各删一份 identity-anchor 黑名单；turn 分组从启发式扫描变为 groupBy。
- `parentID` 语义与用户心智模型对齐："一个任务的所有产出挂在发起它的那条消息下"，digest/summary/experience 等下游不再需要回溯修正。
