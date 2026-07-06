# 前端消息同步：拉取、增量事件与渲染派生

> 所属：Session 核心重构（issue #281，总纲见 `docs/architecture/session-message-core.md`）
> 范围：前端数据层。`packages/app/src/context/sync.tsx`、`packages/app/src/context/global-sync.tsx`、`packages/app/src/pages/session.tsx` 的派生 memo、`packages/ui/src/components/session-turn.tsx` 的分组
> 本文写法：先完整存档现状数据流（重构期间不动的部分要有契约可查），再给出新设计的替换点。

---

## 0. 数据流总览

```
                    ┌────────────── HTTP（首屏/分页/兜底） ──────────────┐
                    │  session.get / session.messages({limit})           │
                    │  session.inbox / permission.list / diff / todo/dag │
                    └────────────────────────┬───────────────────────────┘
                                             ▼
   SSE 事件流 ──────────────────────▶  scope store（solid createStore）
   message.updated / part.updated          store.session   Session[]（id 升序）
   message.removed / part.removed          store.message   {sessionID → Message[]}
   session.updated（含 history）            store.part      {messageID → Part[]}
   session.inbox.updated                   store.inbox     {sessionID → InboxItem[]}
   session.status / compacted / ...        store.session_status / permission / ...
                                             │
                                             ▼
                    session.tsx 派生 memo（过滤/分组）→ 组件渲染
```

两条原则（现状即如此，新设计延续）：

- **服务端返回的消息列表已经是 L2 有效视图**（`server/session.ts:800` → `Session.messages` 应用 history 事件）。前端对回退的过滤只是**事件到达早于重拉**时的即时补偿。
- **前端 store 是按 id 有序的规范化缓存**（消息与 part 分表，Binary.search 插入/替换），渲染语义全部在派生层，store 不存派生结果。

---

## 1. 拉取与分页（现状，机制保持不变）

`sync.tsx` 关键参数与行为：

| 项                           | 值/行为                                                                                                                                      | 位置             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 分页粒度 `chunk`             | 200                                                                                                                                          | sync.tsx:20      |
| 客户端缓存上限 `maxMessages` | 500（超出丢最旧）                                                                                                                            | sync.tsx:21,89   |
| 首屏                         | `session.sync()`：并行 `session.get` + `loadMessages(limit=200)` + permission + inbox（首次）                                                | sync.tsx:239-299 |
| 分页                         | `history.loadMore` → `loadMessages(currentLimit + 200)`——**扩大 limit 整窗重拉**，服务端取尾部 `-limit` 切片，`reconcile(key:"id")` 增量合并 | sync.tsx:331-337 |
| 完整性                       | `meta.complete = 返回数 < limit`；`history.more()` 据此驱动"加载更早"按钮                                                                    | sync.tsx:73,111  |
| in-flight 去重               | `inflight*` Map 按 sessionID 合并并发请求                                                                                                    | sync.tsx:22-26   |
| 乐观发送                     | `addOptimisticMessage`：本地立即插入 user 消息 + parts，等 `message.updated` 事件以 reconcile 收敛                                           | sync.tsx:208-238 |

新设计不改动以上机制。唯一注意点：`maxMessages` 截断可能把当前任务的 root 挤出缓存（超长任务），rootID 分组需要容错（§4.3）。

---

## 2. 增量事件（现状，机制保持不变）

`global-sync.tsx:798-1105` 的处理器逐条列出（与消息相关的部分）：

| 事件                                       | 处理                                                                                                  | 位置      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------- |
| `message.updated`                          | Binary 定位，found→整条 reconcile 替换；未 found→插入。随后 `refreshVolatileStateAfterMessage`        | :866      |
| `message.part.updated`                     | 同上按 part.id；另含 worktree 工具的乐观 workspace 更新                                               | :905      |
| `message.removed` / `message.part.removed` | Binary 定位删除                                                                                       | :890,:947 |
| `session.updated`                          | 整条 Session 替换/插入（**携带 `info.history.rollback`，是回退状态到达前端的通道**）；archived 则移除 | :802      |
| `session.inbox.updated`                    | 整表 reconcile                                                                                        | :862      |
| `session.status`                           | 状态写入；转 idle 时若 inbox 非空则 force 刷新 inbox、有 running cortex 则刷 cortex                   | :845      |
| `session.compacted`                        | 触发相应刷新                                                                                          | :1105     |

注意：**回退不产生 `message.removed`**。被回退的消息留在 store 里，靠派生层过滤（§3）。重新进入会话或重拉时服务端返回的有效视图自然不含它们，reconcile 会把它们从 store 清掉。

---

## 3. 渲染派生层：现状（将被大幅简化的部分）

`session.tsx` 的 memo 链，按依赖顺序：

```
messagesRaw = store.message[id]
  ↓ hiddenMessageIDs = info().history.rollback.droppedMessageIDs     (:196-203)
messages   （回退即时过滤）
  ↓ 四重条件 (:236-255)
userMessages          = user && !metadata.synthetic && !isGuidedContextUserMessage
                        && isSessionIdentityAnchor（手抄黑名单 :224-234）
renderableUserMessages = user && !guided && (!synthetic || hasSpecialUserMessageRenderer)
  ↓
timeline = renderable turns + action command 消息 + mailbox 消息合并 (:332-)
  ↓ ui/session-turn.tsx
collectMessagesForTurnDisplay：从 turn 头顺序前扫，
  isInlineContextUserMessage（synthetic ∨ guided）→ 并入 validParentIDs / 渲染 guided chip
  assistant 需 parentID ∈ validParentIDs                              (:177-206)
```

问题清单（对应总纲 §2.3d）：

1. `isSessionIdentityAnchor` 与后端 `input.ts:139` 双份手抄黑名单；
2. `userMessages` 与 `renderableUserMessages` 语义纠缠（"identity anchor"、"渲染"、"turn 头"三个概念混在两个 memo 里）；
3. turn 分组靠顺序扫描 + 启发式（synthetic/guided），parent 漂移时 `validParentIDs` 集合是补偿手段；
4. composer 的 agent/model 回填依赖 `userMessages` 的黑名单结果（:259-270），blueprint 消息还要单独一个 `lastBlueprintStartModel` memo（:275-294）补漏。

---

## 4. 渲染派生层：新设计

### 4.1 memo 链（全量替换 §3）

```ts
const messagesRaw = () => store.message[sessionID] ?? []

// ① 回退过滤：前缀切割
const cut = () => info()?.history?.rollback?.cutMessageID
const messages = createMemo(() => (cut() ? messagesRaw().filter((m) => m.id < cut()!) : messagesRaw()))

// ② 任务组：一次分组，全页共享
const taskGroups = createMemo(() => {
  const groups = new Map<string, { root?: UserMessage; members: Message[] }>()
  for (const m of messages()) {
    const key = m.rootID ?? m.id // 容错：旧数据/截断缓存见 §4.3
    const g = groups.get(key) ?? { members: [] }
    if (m.role === "user" && m.isRoot) g.root = m
    g.members.push(m)
    groups.set(key, g)
  }
  return groups
})

// ③ 三个正交的派生，各自一行谓词
const rootMessages = createMemo(() => messages().filter((m) => m.role === "user" && m.isRoot))
const visibleRoots = createMemo(() => rootMessages().filter((m) => m.visible !== false)) // turn 头
const lastRoot = createMemo(() => rootMessages().at(-1)) // composer 继承唯一来源
```

删除清单：`isSessionIdentityAnchor`（前端手抄版）、`userMessages`/`renderableUserMessages` 双 memo、`isGuidedContextUserMessage`、`lastBlueprintStartModel`、`ui/session-turn.tsx` 的 `collectMessagesForTurnDisplay` 顺序扫描与 `validParentIDs`。

### 4.2 turn 内展示（替换 collectMessagesForTurnDisplay）

```ts
function turnDisplay(group: TaskGroup): DisplayItem[] {
  return group.members
    .filter((m) => m.id !== group.root?.id)
    .filter((m) => m.visible !== false)
    .map((m) =>
      m.role === "assistant"
        ? assistantTimelineItems(m) // 现有 timeline 逻辑不变
        : { kind: "injected-user", message: m },
    ) // 原 guided-user chip，渲染器按 origin 分发
    .flat()
}
```

- 注入 user 消息（非 root、visible）渲染为 turn 内 inline chip，chip 图标/文案按 `(origin.type, origin.detail)` 二级分发，plugin 按 `pluginID` 查注册渲染器，未知回落通用 chip（总纲 §8.1）。
- `visible === false` 的消息任何模式下不渲染，debug inspector（现有 message 详情面板）不受 visible 限制。

### 4.3 容错规则

- **rootID 缺失**（迁移期旧消息、事件先于迁移到达）：按读时推导兜底——前端不实现推导，直接把该消息当自身为组（`key = m.id`），显示不劣于现状；服务端读路径迁移保证 HTTP 拉取的数据总是带 rootID。
- **root 被 `maxMessages` 截出缓存**：组存在但 `group.root === undefined` → turn 头渲染为"更早的任务（点击加载）"占位，点击触发 `history.loadMore`。
- **孤儿 assistant**（总纲决策 4 的空会话边界）：`group.root === undefined` 且成员全为 assistant → 渲染为独立 assistant 块。

### 4.4 composer 继承

`lastRoot()` 的 `agent`/`model` 是唯一回填来源（现状 :259-270 的 effect 保留，数据源替换）。非 root 消息携带的 agent/model 不参与。

---

## 5. Pending 消息（inbox item）进时间线

### 5.1 现状

inbox 项只存在于状态栏 popover（`session-inbox.tsx`）：mail 图标 + badge 数字，行内 guide（zap）/ remove（x）按钮，`kind`/`deliveryTarget` 决定文案。时间线上不可见——用户发出的排队消息"消失"在气泡外，直到物化才出现。

### 5.2 新设计

**用户投递的 pending 项进时间线尾部**，与已物化消息视觉连续（issue #281 撤回补充评论的统一交互）：

```ts
// 时间线尾部追加
const pendingTimeline = createMemo(() =>
  (store.inbox[sessionID] ?? [])
    .filter((item) => item.message.origin.type === "user") // 用户投递的 task / steer
    .map((item) => ({ kind: "pending", item })),
)
```

| inbox item                        | 时间线呈现                                                     | 可用操作                               |
| --------------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| `mode: "task"`（用户排队消息）    | 尾部 pending 气泡（半透明 + 时钟角标，样式同将来的 root 气泡） | 撤回（删 item）/ Guide（翻转为 steer） |
| `mode: "steer"`（已 guide）       | 尾部 pending chip（同 injected-user chip 样式 + 时钟角标）     | 撤回 / 取消 Guide（翻回 task）         |
| `mode: "context"` 或非用户 origin | 不进时间线，保留在 popover（badge 计数含它们）                 | context：撤回；agent 项：只读          |
| 冻结态（active rollback 期间）    | chip 加"已暂停投递"标记                                        | 同上                                   |

- popover 保留为全量视图（含 context 与 agent 项），但 `kind/state/deliveryTarget` 三字段的展示逻辑（`labelByKind`/`timingLabel`）替换为 `mode` + `origin`。
- pending 项的 key 是 `item.id`；物化后 `session.inbox.updated`（移除 item）与 `message.updated`（新消息，id = item 预分配的 messageID）到达，时间线上 pending 气泡原位替换为正式气泡——**因为 messageID 预分配，可以做无跳变的过渡动画**（同 key 交接）。
- 乐观发送路径统一：running 时发消息不再走 `addOptimisticMessage` 的假 user 消息，而是服务端 enqueue 返回 item 后由 `session.inbox.updated` 渲染 pending 气泡（idle 时仍走乐观消息，因为会立即物化）。

---

## 6. 事件与 SDK 面变化汇总

| 项                           | 现状                                            | 新设计                                                                                       |
| ---------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `session.updated` 的回退载荷 | `history.rollback.droppedMessageIDs`（数组）    | `history.rollback.cutMessageID` + 汇总字段（numTurns/files/patchPartIDs/canUnrollback 保留） |
| `session.inbox.updated` item | kind/state/deliveryTarget/summary/detail/source | `mode` + `message.origin` + `messageID`（预分配）+ summaryPreview                            |
| Message 类型                 | metadata 组合                                   | `rootID`/`isRoot`/`visible`/`includeInContext`/`origin` 一等字段（SDK 已生成，接线）         |
| `message.removed`            | 回退不触发                                      | 不变（回退仍是软删除 + 派生过滤）                                                            |
| 拉取端点                     | `session.messages({limit})` 返回有效视图        | 不变（返回体多新字段）                                                                       |

前端兼容策略：所有新字段读取带 `?? 兜底`（§4.3），确保旧后端/迁移期数据可渲染；派生层切换（本文 §4/§5）对应总纲 Phase 2 的 PR-b，可独立回滚。
