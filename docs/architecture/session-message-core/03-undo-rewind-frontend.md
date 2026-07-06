# Undo / Rewind 前端设计：统一撤回交互

> 所属：Session 核心重构（issue #281 及其撤回机制补充评论）
> 范围：前端交互与其依赖的 API 面。`packages/app/src/components/session/commands.tsx`、`quick-actions.tsx`、`session-inbox.tsx`、`packages/app/src/pages/session.tsx`、`packages/app/src/utils/prompt.ts`、新增确认弹层组件
> 依赖：`02-frontend-message-sync.md` 的派生层与 pending 时间线；后端 `RollbackEvent.cutMessageID` 通用化与"active rollback 冻结非 task drain"规则

---

## 0. 语义回顾（来自 issue #281 补充评论）

撤回只有两种合法形式，UI 的职责是把它们统一成**一个用户动作**：

|        | ① 排队撤回                 | ② rewind                                            |
| ------ | -------------------------- | --------------------------------------------------- |
| 对象   | 未消费的 inbox item        | 已物化、已被模型消费的消息                          |
| 实现   | 删除 item，O(1) 无副作用   | 前缀切割：drop 目标消息及其后所有消息（软删除事件） |
| 可逆性 | toast 内可恢复（重新投递） | redo（unrollback），直到用户启动新 root             |
| 文件   | 无涉                       | 不自动动文件；确认弹层可勾选联动 restoreFiles       |

不支持"抠掉中间一条、保留其后工作"（因果不一致，见 issue 评论）。

---

## 1. 现状 UI 存档

| 入口                            | 行为                                                                                                                   | 位置                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `/undo` 命令、quick-action chip | running 则先 abort → `session.rollback({numTurns:1})` → `extractPromptFromParts` 回填输入框 → activeMessage 移到上一条 | commands.tsx:196-218 |
| `/redo` 命令、chip              | `session.unrollback()`，`disabled` 由 `info().history.rollback.canUnrollback` 驱动                                     | commands.tsx:221-233 |
| "Restore files" 命令            | `session.files.restore({rollbackID})`，独立于 undo                                                                     | commands.tsx:236-253 |
| inbox popover                   | queued_user 行内 Guide（zap）/ Remove（x）；agent_update 只读                                                          | session-inbox.tsx    |
| 回退可视反馈                    | 消息静默消失（`hiddenMessageIDs` 过滤），无横幅、无 redo 提示、无"能撤到哪"的预览                                      | session.tsx:196-203  |

痛点：撤回能力散在三个不相关入口（命令面板、popover、无消息级手势）；undo 的粒度不可见（用户不知道一次 undo 会撤掉什么）；redo 的失效是静默的；排队消息与已发送消息在 UI 上是两个世界。

---

## 2. 目标交互总览

**心智模型：时间线上每个用户侧条目有同一个"撤回"动作，代价差异由确认交互的轻重传达。**

```
时间线（自上而下）
┌──────────────────────────────────────────────┐
│ ● root 气泡（任务 A）            hover: [⤺ 撤回] │ ← rewind 到任务 A 之前（= /undo 对齐步长）
│   ├ assistant 输出…                            │
│   ├ ▸ steer chip（用户插话）     hover: [⤺ 撤回] │ ← rewind 到该 steer 之前（消息级切点）
│   └ assistant 输出…                            │
│ ● root 气泡（任务 B）            hover: [⤺ 撤回] │
│   └ assistant 输出…（进行中）                   │
│ ◌ pending 气泡（排队任务 C）  hover: [× 撤回][⚡Guide] │ ← 删 inbox item，无确认
│ ◌ pending chip（已 guide 的 D）hover: [× 撤回][↩转排队] │
└──────────────────────────────────────────────┘
     ▲ 回退后顶部出现横幅：
┌──────────────────────────────────────────────┐
│ ⤺ 已回退 2 条消息（1 个任务）· [重做] [恢复文件(3)] [×] │
└──────────────────────────────────────────────┘
```

三条设计规则：

1. **同一图标、同一措辞（"撤回"）**，不同状态只改确认重量：pending → 无确认 + toast 可恢复；已消费 → 确认弹层列明代价。
2. **`/undo` `/redo` 命令语义不变**（root 步长、连按可重复），它们是消息级手势的快捷路径，不是另一套机制。
3. **一切回退可视**：active rollback 必有横幅；redo 失效必有原因提示；冻结的投递必有标记。

---

## 3. 各交互详细规格

### 3.1 pending 项撤回（①）

- 触发：pending 气泡/chip hover 的 `×`，或 popover 行内 `×`（保留）。
- 行为：`session.inboxRemove({sessionID, itemID})`，无确认。
- 反馈：toast "已撤回排队消息 · [恢复]"，恢复 = 用原 payload 重新 `deliver`（item 数据在前端 store 中仍有一帧可用；恢复后 orderKey 变化即排到队尾，toast 文案注明）。
- Guide 翻转（task ↔ steer）同位按钮，无确认，即时生效（`session.inboxGuide` 及新增的反向端点）。

### 3.2 rewind（②）：消息级手势

- 触发：root 气泡或 steer chip hover 的 `⤺ 撤回`；命令面板新增 "Rewind to here"（作用于 activeMessage）。
- 前置：session running 时先提示 abort（沿用现状 undo 的 abort-first 行为，弹层内合并说明："将停止当前运行"）。
- 确认弹层（唯一新增组件 `DialogRewindConfirm`）内容，全部由前端 store 计算，无需 dry-run 端点：

```
回退到「{目标消息摘要 ≤60 字}」之前？

将撤回：
  · {N} 条用户消息、{M} 轮回复          ← messages().filter(id >= cutID) 分类计数
  · 涉及文件 {k} 个：a.ts, b.ts, …      ← 区间内 patch parts 的 files 去重
  ☐ 同时把这些文件恢复到回退点（可稍后在横幅中恢复）

[取消]  [撤回]
```

- 执行：`session.rollback({sessionID, cutMessageID})`（新参数形式）→ 勾选了文件恢复则接着 `session.files.restore({rollbackID})`。
- 完成反馈：目标区间消息淡出（§02 文档的 `cut()` 过滤生效），顶部出现回退横幅，输入框按 §3.5 回填。

### 3.3 `/undo` 与 `/redo`（root 步长快捷路径）

- `/undo` = 对 `visibleRoots().at(-1)` 执行 rewind，`cutMessageID = 该 root.id`。**首次在会话中使用时走同样的确认弹层，勾选"不再询问"后免确认**（root 步长是最常用路径，不能每次打断；消息级手势因为切点任意，恒确认）。
- 连按 `/undo`：每次以当前有效视图的最后一个 root 为切点，事件叠加（activeRollbacks 栈语义与现状一致）。
- `/redo` = `session.unrollback()`，恢复最近一次切割；chip 的 disabled 与横幅按钮共用 `canUnrollback`。

### 3.4 回退横幅（新增，替代"静默消失"）

- 出现条件：`info().history.rollback` 存在（active）。
- 内容：`已回退 {droppedCount} 条消息（{numTurns} 个任务）`（消息级切点显示"回退到消息中途"）+ 三个操作：
  - **重做**：unrollback；
  - **恢复文件({k})**：`restoreFiles`，k = `rollback.files.length`，为 0 时隐藏；
  - **×**：仅收起横幅（回退状态不变，命令面板仍可 redo）。
- redo 失效时（用户发出新 root）：横幅变一次性 toast "已开始新任务，回退不可重做"，随后消失。失效判定由后端 `canUnrollback` 驱动（新语义：仅新 root 使之失效）。

### 3.5 输入框回填

- root 步长 undo：回填被撤 root 的用户原文——`extractPromptFromParts` 的 text part 筛选从 `!synthetic && !ignored`（prompt.ts:36）改为 `part.origin === "user"`（origin 缺省视为 "user"，天然兼容旧数据）；附件/inline 引用还原逻辑不变。
- 消息级 rewind：回填**切点那条消息**的原文（用户通常想改写它重发）；若切点是非用户 origin（如回退到一条 cortex 通知之前），不回填。
- 多次 undo：每次覆盖回填为最新被撤 root 的内容（与现状一致）。

### 3.6 冻结投递的呈现

active rollback 期间后端冻结非 task drain（issue 补充评论），前端同步表达：

- pending steer/context chip 加"已暂停投递"角标 + tooltip"回退期间暂停，重做或开始新任务后继续"；
- inbox popover 顶部同款提示行；
- redo 或新 root 后角标消失（由 `session.inbox.updated` 与 `session.updated` 自然驱动，无需额外事件）。

---

## 4. 状态机

```
                 rollback(cutID)                    unrollback
      ┌──────────────────────────▶ ROLLED_BACK ──────────────────┐
      │                            · 横幅显示                      │
   NORMAL ◀────────────────────────· 非 task drain 冻结 ◀─────────┘
      ▲                            · canUnrollback = true
      │        新 root 启动         │
      └────────────────────────────┘ → DEAD_BRANCH（事件保留，横幅转 toast，
                                       冻结解除，被冻结项绑新 root 排水）
```

对应前端唯一的状态来源是 `info().history.rollback`（存在 + canUnrollback 两个布尔），不引入本地状态副本；横幅收起状态是仅有的本地 UI state。

---

## 5. 需要的后端/API 配套（本文依赖，实现属后端计划）

| 项                 | 变化                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `session.rollback` | 入参增加 `cutMessageID`（与 `numTurns` 二选一；numTurns 在服务端换算为对应 root 的 cutMessageID）       |
| `RollbackEvent`    | 通用形式（cutMessageID），`droppedMessageIDs`/`files`/`patchPartIDs` 保留为汇总字段供横幅与恢复文件使用 |
| `canUnrollback`    | 失效条件收紧为"出现新 root"（配合冻结规则；现状是"任何新消息"）                                         |
| inbox              | `inboxGuide` 反向端点（steer → task）；remove 对 task/steer/context 三类用户投递均可用                  |
| 事件               | 无新增事件类型；横幅/冻结全部由 `session.updated` + `session.inbox.updated` 驱动                        |

---

## 6. 组件改动清单

| 文件                               | 改动                                                                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands.tsx`                     | `session.undo` 改走 rewind 路径（cutMessageID = last root）+ 确认弹层；`session.redo` 文案与 disabled 逻辑接新 `canUnrollback`；新增 "Rewind to here" 命令；`session.restore_files` 保留 |
| `quick-actions.tsx`                | Undo/Redo chip 保留，指向新命令                                                                                                                                                          |
| 新增 `dialog/rewind-confirm.tsx`   | §3.2 确认弹层（含代价计算 memo 与"同时恢复文件"勾选）                                                                                                                                    |
| 新增 `session/rollback-banner.tsx` | §3.4 横幅                                                                                                                                                                                |
| `session.tsx`                      | `hiddenMessageIDs` 集合过滤 → `cut()` 前缀过滤（§02 §4.1）；挂载横幅；pending 时间线合流（§02 §5）                                                                                       |
| `session-turn.tsx`（ui 包）        | root 气泡与 injected chip 的 hover 撤回按钮；pending 态样式（半透明 + 时钟角标 + 冻结角标）                                                                                              |
| `session-inbox.tsx`                | popover 精简为全量列表 + 冻结提示；`labelByKind`/`timingLabel` 替换为 `mode`+`origin` 展示；行内按钮语义不变                                                                             |
| `utils/prompt.ts`                  | text part 筛选改 `part.origin === "user"`（:36）                                                                                                                                         |

---

## 7. 边界情况

1. **running 中 rewind**：先 abort（确认弹层内说明），abort 丢当前任务 pending steer 的规则与 rewind 的冻结规则叠加时以 rewind 为准（都发生：abort 清 steer → rollback 冻结此后到达的）。
2. **切点消息不在客户端缓存**（maxMessages 截断）：hover 手势自然不存在（消息没渲染）；命令面板 rewind 对 activeMessage 操作，activeMessage 必在缓存中。
3. **回退跨 compaction 边界**：cut 点早于 compaction 摘要时，摘要 assistant 一并被切（它 id 更大），有效视图回到 compaction 前的原始消息——上下文可能重新变大，下轮预算判断会自然再触发 compaction。弹层不需要特殊提示（对用户透明）。
4. **被撤区间含 pending 文件恢复数据缺失**：patch part 无 snapshot hash 时 restoreFiles 会抛 `FileRestoreMissingPatchDataError`，横幅"恢复文件"按钮 catch 后 toast 说明（现状 restore_files 命令已有同类处理）。
5. **多端并发**：另一端做了 rewind，本端由 `session.updated` 收到 rollback 状态——横幅照常出现；本端若正在确认弹层中提交，服务端以事件序为准（后到的 rollback 叠加或因 assertIdle 失败返回错误 toast）。
6. **pending 恢复竞态**（§3.1 的 toast 恢复）：原 item 已被 drain（loop 恰好启动）时恢复操作变为普通新投递，文案不变，行为正确。
