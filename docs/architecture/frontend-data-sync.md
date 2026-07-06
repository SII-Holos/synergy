# 前端数据同步重构设计：单一事实源、序列号协议与意图分层

> 状态：设计稿（未实施）。
> 背景：issue #318（数据所有权与时序）、issue #319（BlueprintLoop 全量重渲染）、#281 的 session core 语义重构（已合入，本文是它在"前端拉取/同步/渲染"侧的对偶工程）。
> 范围：`packages/app/src/context/{global-sync,sync,local,layout}.tsx`、`packages/app/src/pages/session.tsx`、`packages/synergy/src/server/server.ts` 事件流、`packages/synergy/src/session/index.ts` 事件发布、session/nav 相关 REST 契约。

---

## 1. 现状诊断

### 1.1 核心结论

前端现在没有"一个数据模型 + 一个同步协议"，而是**八九条互不承诺一致性的数据通道**各自为政。每条通道有自己的 owner、自己的刷新时机、自己的合并策略（replace / reconcile / merge / debounce refetch），彼此之间没有任何 freshness 仲裁。#318 的 model selector 覆盖和 #319 的整页闪烁不是两个 bug，而是同一个结构性缺陷的两个投影：

1. **REST 快照和事件流之间没有序列边界** —— 前端永远无法回答"这个 fetch 结果比刚收到的 event 新还是旧"；
2. **store 写入没有统一闸门** —— 有的地方 `reconcile`，有的地方整对象替换，有的地方 debounce 后全量重拉，粒度失控直接放大为渲染雪崩；
3. **用户意图和服务端事实写进同一个格子** —— 后到者赢，用户的显式选择可以被一次历史加载静默覆盖。

### 1.2 数据通道矩阵（实证）

| 通道                   | 前端写入点                                                   | 合并策略                                                                                                               | 问题                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| session 列表           | `global-sync.tsx:818-825`（`session.updated`）               | `produce` 里 **整对象替换** `draft[i] = info`                                                                          | 每个事件使 `info()` memo 失效，级联重算 `messages()`→`visibleRoots`→整条时间线（#319 根因）                                             |
| session 详情（切换时） | `sync.tsx:265-279`                                           | `produce` 整对象替换                                                                                                   | 同上；且与事件写入路径是两套代码                                                                                                        |
| messages               | `sync.tsx:76-118`（REST）、`global-sync.tsx:866-888`（事件） | REST 用 `reconcile`；事件按 id 二分插入                                                                                | 裸数组、无版本；fetch 晚返回可以覆盖事件已写入的更新状态                                                                                |
| parts                  | `global-sync.tsx:905-923`                                    | found 时 **整对象替换** `setStore(..., index, part)`                                                                   | 高频事件 + 无 sequence，无法检测乱序/重复；stale full-part 可覆盖新状态                                                                 |
| sidebar nav            | `layout.tsx:497-553`                                         | 每个 `session.updated` → **300ms debounce 后全量 REST 重拉** `refreshScopeNav`/`refreshGlobalRecent`/`loadScopeIndex`  | 与 session store 完全独立的第二事实源；merge（`mergeNavListByID`）而非严格 reconcile，archived 项可滞留；blueprint storm 时变成重拉风暴 |
| inbox/todo/dag         | `sync.tsx:120-190` + `global-sync.tsx:563-572`               | 事件有 `session.inbox.updated`，但 **每条 `message.updated` 还会触发 REST 重拉**（`refreshVolatileStateAfterMessage`） | 事件与轮询式重拉并存，streaming 期间反复打后端                                                                                          |
| model/agent 选择       | `local.tsx:402-416` + `session.tsx:312-327`                  | 后到者赢                                                                                                               | 见 1.3（#318 根因）                                                                                                                     |
| session_status         | `global-sync.tsx:845-861`                                    | reconcile                                                                                                              | 相对健康，但 idle 时又挂了 inbox/cortex 重拉副作用                                                                                      |
| compaction             | `global-sync.tsx:1105-1151`                                  | **先删光 message/part 再 REST 重拉**                                                                                   | 删除与重拉之间时间线为空 → 可见闪烁                                                                                                     |

### 1.3 #318 的覆盖链路（实证）

- `session.tsx:312-327`：`lastRoot()` 变化（包括"消息刚加载完"）→ 无条件 `local.agent.set(msg.agent)` + `local.model.set(msg.model)`。
- `local.tsx:170-174`：`ephemeral.model` 以 **agent name** 为 key，不区分 session、更不区分"用户选的"还是"历史推导的"。
- `local.tsx:322-332`：`current()` 的 fallback 链 `ephemeral[agent] → agent.model → config/recent/provider default`，五种语义压在一个格子里。
- 服务端有 `Session.Info.modelOverride`（`session/types.ts:177`，`/model` 命令写入），但 `PATCH /session/:id` 的 schema（`server/session.ts:427-444`）**不接受** `modelOverride` —— 前端没有任何持久化"本 session 的 model 偏好"的正规写入口。

### 1.4 #319 的放大链路（实证）

- `blueprint/loop-store.ts:184` 每个节点状态迁移调用 `Session.update(parentSessionID, ...)`；
- `session/index.ts:277-281` `publishInfo` **无条件**发布完整 info；
- `global-sync.tsx:821-823` 整对象替换 → `info()` memo 返回新引用 → Solid 把整条依赖链视为脏；
- 一次 blueprint run 产生 10-50 次全链路重算，每次可见一次"闪"。

### 1.5 其他结构性问题（代码走读新发现）

a) **双重 sync**。`session.tsx:471-482`（`params.id` effect）和 `session.tsx:484-488`（`sdk.connected` effect）都调 `sync.session.sync(id, { refreshVolatile: true })`；`sync.tsx` 里靠 `inflight` map 勉强去重，但 `refreshVolatile` 分支每次都强制重拉 inbox/todo/dag 三个接口。

b) **加载阶段没有状态机**。`messagesReady`（`session.tsx:276-280`）只是 `store.message[id] !== undefined`；`hydratedSessions`/`initializedSessions` 两个模块级 `Set`（`session.tsx:468-469`）手工模拟"每 session 只做一次"的生命周期；`meta.limit/complete/loading`（`sync.tsx:27-31`）是第三套。同一个"这个 session 处于什么加载阶段"的问题有三份互相不知情的答案。

c) **事件传输是单通道 firehose**。`server.ts:558`（global WS）把 GlobalBus 上**所有 scope 所有类型**的事件广播给每个客户端，无过滤、无 seq、无背压；`message.part.updated` 的文本 delta 和 sidebar 关心的 `session.updated` 挤在同一管道同一处理函数里（`global-sync.tsx:693-1154` 一个 460 行的 switch）。

d) **内存无 eviction**。`store.part` 以 messageID 为 key 全局累积，切换过的 session 的 messages/parts 永不释放；`maxMessages = 500` 只在单 session 内截断。

e) **快照无版本**。`GET /session/:id/messages` 返回裸 `WithParts[]`（`session/index.ts:625-635`），`GET /session/status`、`GET /session/index` 同样没有任何 watermark。reconnect 后 `resyncInstance`（`global-sync.tsx:597-629`）只能全量重拉一切。

---

## 2. 设计目标

1. **单一事实源**：每类实体在前端只有一个 normalized store；sidebar、时间线、selector 都是它的派生视图。
2. **可判定的新旧**：任何一次写入（REST 快照或事件）都能在 O(1) 内判定"该不该应用"，彻底消灭 stale overwrite。
3. **细粒度反应性**：一个字段变化只重算读它的订阅者。`session.updated` 只改 `time.updated` 时，时间线一个像素都不应该动。
4. **意图与事实分层**：用户在 UI 里做出的选择永远不会被服务端数据静默覆盖。
5. **协议通用、可测试**：同步内核是纯函数 `(store, incoming) → store`，可以离线单测乱序/丢失/重复/晚到的所有排列。
6. **渐进落地**：每阶段独立可合，P0 不改协议就能消灭 #318/#319 的用户可见症状。

**非目标**：不重做 #281 的消息语义；不引入前端框架级改造（仍是 Solid store）；不做离线优先/CRDT。

---

## 3. 核心设计

整体分六层，前三层在服务端，后三层在前端。

```
┌─ 服务端 ────────────────────────────────────────────┐
│ L1  Scope 单调序列号 + 事件 journal + 快照水位线      │
│ L2  事件分级 / part 合并 / publishInfo 去重           │
│ L3  Nav = Session 投影；modelOverride 公开写入        │
├─ 前端 ─────────────────────────────────────────────┤
│ L4  Normalized store + 唯一写入闸门 (apply gate)      │
│ L5  Session 生命周期状态机                            │
│ L6  Composer 意图分层 (draft / sessionDefault / fb)   │
└────────────────────────────────────────────────────┘
```

### 3.1 L1：序列号协议（snapshot + oplog，业界标准做法）

**服务端**：每个 scope runtime 维护一个单调递增计数器。`Bus.publish` 在发布时给事件盖章：

```ts
type EventEnvelope = {
  seq: number        // scope 内单调递增；进程内计数，重启后从持久化水位 + 大步长恢复
  epoch: string      // runtime 实例标识；epoch 变化 = 客户端强制全量 resync（seq 回退兜底）
  scopeID: string
  type: string
  properties: {...}
}
```

同时保留一个环形 journal（内存即可，**4096 条 + 5 分钟双上限**；`stream` 类事件不进 journal——丢了由下一条全量 part 锚点自愈），支持 `GET /event/replay?since=<seq>`：seq 还在窗口内 → 返回缺失事件；太旧 → 返回 410，客户端做域级全量 resync。

**快照信封**：所有会与事件流竞争的 REST 响应升级为 `{ seq, data }`：

- `GET /session/:id/messages` → `{ seq, items: WithParts[] }`
- `GET /session`、`GET /session/status`、`GET /session/index`、`GET /session/:id/inbox|todo|dag` 同理。

`seq` 取"生成快照那一刻"的 scope 计数器读数（与读数据在同一临界区内，保证：seq 之前的变更都已反映在 data 里）。

**客户端仲裁规则**（全部实现在 L4 的闸门里，共四条）：

1. 事件 `seq <= bucketSeq[域:key]` → **丢弃**（重复或已被更新的快照覆盖）；
2. 事件 `seq == streamSeq + 1`（流内连续）→ 应用，推进水位；
3. 事件出现 **gap**（`seq > streamSeq + 1`）→ 先试 replay，失败则把受影响 scope 标记 `resyncing` 并重拉快照；
4. 快照 `seq < bucketSeq[域:key]` → **丢弃整个响应**（晚返回的旧 fetch，#318 §6.1 的竞态从此不可能发生）；否则 `reconcile` 应用并把 bucket 水位推到快照 seq。

`bucket` 的粒度 = (域, key)，如 `("messages", sessionID)`、`("session", scopeKey)`、`("inbox", sessionID)`。规则 1/4 用 bucket 水位，规则 2/3 用流水位，两个水位合计十几行代码。

这一层直接取代今天所有的"晚返回怕不怕覆盖"式防御（`inflight` map 仍保留用于请求去重，但不再承担正确性职责）。

### 3.2 L2：事件分级、合并与去重

**a) part 流式改为 delta-first + 服务端 write-behind**。现状是双重 O(part²)：`processor.ts:731` 每个流式文本 chunk 调一次 `updatePart`，而 `updatePart`（`session/index.ts:913-927`）每次都 ① 把**完整 part** 重写一遍磁盘（`Storage.write`），② 把**完整 part** JSON 广播给每个客户端（`delta` 字段只是附赠）。一段 100KB 的回复意味着上千次全量文件重写和上千份逐次变长的全量 payload。改为：

- **广播 delta-first**：流式期间只发 `{partID, pseq, delta}`（`pseq` 为 part 内自增小序号）；每 ~50ms 或每 N 个 delta 发一次完整 part 作为锚点；**状态迁移/终态**（工具开始/完成/错误、文本完成）立即发完整 part。客户端按 `pseq` 连续性追加 delta，检测到断档就拉一次完整 part 自愈。网络量从 O(part²) 降到 O(part)。
- **存储 write-behind**：流式中的 part 缓冲在内存，按间隔（~500ms）+ part 终态 + session idle 三个时机冲刷磁盘。崩溃损失上限是一个流式中 part 的最后半秒——本就是可重新生成的中间态。磁盘 I/O 同样从 O(part²) 降到 O(part)。

**b) 事件分级标签**。信封加一个 `class: "state" | "stream"`：`stream` = part delta 这类可合并可丢弃（丢了下一条全量 part 会补），`state` = session/message/status/inbox 等不可丢。客户端对 `stream` 类在同一 microtask 内做 batch 应用（`batch()` 包裹），对 `state` 类立即应用。gap 检测只对 `state` 严格。

**c) `publishInfo` 值去重**。`session/index.ts:277` 发布前与上一次已发布的 info 做深比较（排除 `time.updated`——单独比较，若**只有** `time.updated` 变化则降频为 ≥1s 一次）。blueprint 节点迁移若未改动 session 可见字段，事件直接不发。这是服务端对 #319 的第一道闸。

**d) WS 订阅过滤**。`/global/event/ws` 支持客户端声明订阅范围（scope 集合 + 事件类型集合），服务端只推匹配事件。桌面端单 scope 场景下不再收全量 firehose。

### 3.3 L3：Nav 统一为 Session 投影 + modelOverride 公开

**a) NavEntry ≡ projection(Session.Info)**。约定 nav 需要的所有字段（title、lastActivityAt、status 摘要、parentID、scope、pinned…）都是 `session.updated` 事件 payload 的子集。于是：

- sidebar 对 `session.updated` 的响应从"debounce 300ms → 全量 REST 重拉三类列表"（`layout.tsx:497-553`，整段删除）变为：**直接把事件应用到 nav store**——按 id upsert、按 `lastActivityAt` 重排一项、archived 则移除。O(log n) 且零 REST。
- `GET /session/index` / `GET /global/nav/recent` 只在 bootstrap 和分页（游标翻页）时调用；响应带 seq 信封，闸门规则同 3.1。
- `mergeNavListByID` 的"merge 不删除"语义废除：快照应用 = 该分页窗口内严格 reconcile；窗口外条目只能由事件驱动进出。

**b) `PATCH /session/:id` 接受 `modelOverride`**（含 `null` 清除）。它成为"本 session 的 model 偏好"的**唯一持久化事实**，selector 显式选择时写入（见 L6），channel `/model` 命令走同一条路。loop 侧已有消费逻辑，无需改动。

### 3.4 L4：Normalized store + 唯一写入闸门

现在的 `State`（`global-sync.tsx:65-109`）保持"按 scope 分桶"不变，但内部重构为 normalized 形态 + 单一写入口：

```ts
type ScopeStore = {
  seq: { stream: number; bucket: Record<string, number> }
  entities: {
    session: Record<string, Session>          // 不再是数组
    message: Record<string, Message>
    part:    Record<string, Part>
  }
  index: {
    sessionIds: string[]                       // 有序，nav/列表共用
    messageIdsBySession: Record<string, string[]>
    partIdsByMessage: Record<string, string[]>
  }
  volatile: { status, inbox, todo, dag, permission, question, ... }  // 现状结构保留
}

// 全 store 只有两个写入口：
applyEvent(scope, envelope)            // 3.1 规则 1-3 + 按类型分发的 reducer
applySnapshot(scope, bucket, seq, data) // 3.1 规则 4 + reconcile
```

**关键约束**：

1. reducer 内部一律 `reconcile`（对象）或增量 splice（索引数组），**禁止**整对象替换。`session.updated` 只改了 `time.updated` 时，订阅 `entities.session[id].title` 的 memo 不会重算——这是 #319 的前端根治（服务端 3.2c 是纵深防御）。part 同理：现在 found 分支整对象替换（`global-sync.tsx:913`），一个 30 字段的 tool part 每来一个 delta 就整体重渲染；reconcile 后流式文本只更新 `text` 一个叶子，配合 3.2a 的 delta-first 直接做字符串追加。
2. `sync.session.get(id)` 变成 `store.entities.session[id]`：key 访问只订阅该 key，不再像 `Binary.search(store.session, …)` 那样隐式订阅整个数组。这类"整数组订阅"现在遍地都是——`session.tsx:510` 的 `currentSession = sync.data.session.find(...)`、`parentSession`、`forkedFromSession` 全是线性 find + 全数组依赖，**任何一个** session 的更新事件都会让**所有**打开组件里的这些 memo 重跑。normalize 后 `info()` 只在该 session 的对象身份变化时失效，而 reconcile 保证身份永不变化。
3. 460 行的事件 switch（`global-sync.tsx:693-1154`）拆成 `reducers/{session,message,part,volatile,nav}.ts` 纯函数表，`(draft, event) => void`，直接可单测。
4. `message.updated` 不再触发 inbox/cortex 的 REST 重拉（`refreshVolatileStateAfterMessage` 删除）——inbox 已有 `session.inbox.updated` 事件，cortex 已有 `cortex.task.*` 事件，事件流在 L1 之后是可信的。
5. **eviction**：`index.messageIdsBySession` 记录 LRU；非当前 session 的 message/part 桶在（比如）保留最近 3 个 session 或 10 分钟后整桶释放，对应 bucket 水位一并清除（下次进入走快照）。nav 只依赖 session 实体，不受影响。
6. optimistic message（`sync.tsx:208-238`）保留：本地写入后，服务端 `message.updated` 事件带着相同 id 到达时被 reconcile 吸收，天然收敛。

### 3.5 L5：Session 生命周期状态机

取代 `messagesReady` + `hydratedSessions` + `initializedSessions` + `meta.{limit,complete,loading}` 四套并行状态：

```ts
type SessionResource = {
  detail: "absent" | "loading" | "ready" | "error"
  messages: "absent" | "loading" | "ready" | "resyncing" // resyncing: 保留旧数据渲染
  window: { oldestLoadedID?: string; complete: boolean } // 向上翻页游标
  live: boolean // 事件流连通且无 gap
}
```

- 唯一入口 `ensureSession(sessionID)`：幂等，`session.tsx:471-488` 的两个 effect 合并为一个（`params.id` 或 `sdk.connected()` 恢复时调用同一函数）；重复调用因 detail/messages 已是 `ready` 而直接返回。
- **切换竞态**由 3.1 规则 4 兜底：旧 session 的晚返回快照因 bucket 不同根本写不进新 session；同 session 的旧快照因 seq 落后被丢弃。不再需要 epoch/请求代数。
- **reconnect**：`resyncInstance` 的"全量重拉一切"改为：先试 `replay(since=streamSeq)`，成功则零 REST 恢复；失败才对各 bucket 做快照重拉，且重拉期间状态为 `resyncing`（继续渲染旧数据），不是 `loading`（白屏）。
- **compaction**：`session.compacted` 处理器（`global-sync.tsx:1105-1151`）从"删光 → 重拉"改为"标记 `resyncing` → 拉快照 → 单次 `reconcile` 原子换血"。时间线在换血完成前保持旧内容，闪烁消失。
- **消息分页**：`limit` 语义换成基于 message id 的游标（id 全局有序，#281 已保证）：`GET /session/:id/messages?before=<id>&limit=200`。翻页结果只 merge 进窗口下沿，不触碰头部水位。

UI 各处 readiness 全部从这一个 resource 派生：`messagesReady = messages !== "absent" && messages !== "loading"`；composer 可用性、selector 语义（见 L6）同源。

### 3.6 L6：Composer 意图分层（#318 根治）

三层，严格优先级，**永不反向写**：

```ts
// 第 1 层：用户本次显式意图（草稿）—— per-sessionID，仅内存
//（不持久化到 localStorage：刷新即弃，持久语义由 modelOverride 承担）
composerDraft: Record<sessionID, { agent?: string; model?: ModelKey; variant?: string }>

// 第 2 层：session 事实（只读派生，永不被 UI 写入）
sessionDefault = createMemo(
  () =>
    session.modelOverride ?? // 服务端持久偏好（L3b 打通写入口后成为主通道）
    lastRoot()?.model ?? // 历史继承（纯派生，不再写回任何 store）
    agent.current()?.model, // agent 默认
)

// 第 3 层：全局 fallback（config → recent → provider default，现状逻辑保留）

effective = composerDraft[sessionID] ?? sessionDefault() ?? fallback()
```

规则：

1. 用户在 selector 选择 → 写 `composerDraft[sessionID]`（+ recent 列表），**并同步 `PATCH modelOverride` 持久化**——显式选择即持久化，语义 = "这个 session 以后都用它"，与 channel `/model` 命令完全一致。
2. messages 加载完成 → `lastRoot` 变化 → 只影响 `sessionDefault` 这个 **memo**。`session.tsx:312-327` 的回写 effect **整体删除**。draft 存在时用户看到的值纹丝不动——覆盖在类型上就不可能发生，不靠 dirty flag 的时序纪律。
3. 发送 prompt：`effective` 随消息落库（成为新的 `lastRoot.model`，第 2 层自动收敛），发送后清除该 session 的 draft。
4. agent 的 `move/cycle` 副作用（`local.tsx:111-128` 里 `model.set`）同样只写 draft。
5. `ephemeral.model`（agent-scoped，`local.tsx:170-174`）删除——它的两个职责分别由 draft（session-scoped 意图）和 `agent.model`（第 2 层）承接。跨 session 串扰随之消失。
6. blueprint start model 回填 effect 同理删除，改为 `sessionDefault` 链上的一个派生源（如果确需保留该语义）。

Selector UI 可以顺带获得可解释性：当前值来自 draft/override/历史/默认，四种来源可在 tooltip 里如实展示。

---

## 4. 关键时序推演

**A. 切换 session 且用户在加载窗口内改 model（#318 场景）**
路由变化 → `ensureSession(B)` → detail/messages 进入 loading，selector 立即按 `draft[B] ?? sessionDefault(B) ?? fallback` 显示。用户此刻选择 model X → 写入 `draft[B]`。messages 快照返回 → 闸门校验 seq → reconcile 写入 → `lastRoot` 变化 → `sessionDefault` 重算 → **effective 仍 = draft = X**。用户选择不可能被覆盖。

**B. Blueprint 子任务风暴（#319 场景）**
节点迁移 → `Session.update` → publishInfo 值去重（未变则不发）→ 即便发出，客户端 reducer `reconcile(info)` → 只有真正变化的叶子路径失效 → 时间线的 `messages()` 依赖 `index.messageIdsBySession[id]` 与各 message 实体，与 session info 的 blueprint 进度字段无关 → **零重渲染**。sidebar 里该 session 的状态徽标（订阅了对应字段）精确更新。

**C. 晚到的旧快照**
切到 A → fetch₁ 发出 → 网络慢 → 用户发消息，事件把 bucket("messages", A) 水位推到 seq=120 → fetch₁ 返回（seq=95）→ 规则 4 丢弃 → 不闪不倒退。

**D. 断线重连**
WS 断开 → resource.live=false（UI 可显示 stale 标记）→ 重连 → `replay(since=streamSeq)` → 命中 journal：补发缺失事件，水位续上，全程零 REST、零闪烁；未命中：受影响 bucket 进 `resyncing`，旧数据持续渲染，快照到达后原子换血。

**E. Rewind / undo**
`session.rollback` → 服务端发 `message.removed` × N + `session.updated`（携带新 `history.rollback`）→ 闸门顺序应用 → 时间线的 prefix-cut 派生（`session.tsx:212-235`，#281 已实现）照常工作。若某个 messages fetch 在 rollback 前发出、之后返回，seq 落后被丢弃——被撤回的消息不可能"复活"。

**F. 同 scope 多窗口/多 tab**
每个客户端各自维护水位；事件广播天然一致；快照信封保证各自的 fetch 竞态独立解决。无需额外机制。

---

## 5. 性能热点清单与解决映射

旧代码的性能问题不只是"#319 闪一下"，下面是完整的热点账本。⬤ = 本设计直接解决，◐ = 显著缓解，标注对应层。

### 5.1 服务端

| #   | 热点                                                                                                           | 量级                                                         | 解决                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **每个文本 delta 全量重写 part 文件**（`processor.ts:731` → `index.ts:918` `Storage.write` 整个 part）         | O(part²) 磁盘 I/O：100KB 回复 ≈ 上千次逐次变大的全量写       | ⬤ L2a write-behind：内存缓冲，间隔/终态/idle 三时机冲刷                                                                                             |
| S2  | **每个 delta 广播完整 part 给所有客户端**（`index.ts:922` payload 含全量 part）                                | O(part²) × 客户端数 网络量                                   | ⬤ L2a delta-first：流式只发 `{partID, pseq, delta}`                                                                                                 |
| S3  | **firehose 无过滤**：`/global/event/ws`（`server.ts:558`）把所有 scope 所有类型广播给每个客户端                | 每客户端收全网事件，串行 `JSON.stringify` × 客户端数         | ⬤ L2d 订阅过滤                                                                                                                                      |
| S4  | **blueprint 等高频 `Session.update` 无条件 publish**（`index.ts:277`）                                         | 每节点迁移一条全量 session info                              | ⬤ L2c 值去重 + `time.updated`-only 降频                                                                                                             |
| S5  | **reconnect 惊群**：`resyncInstance` 每 scope 全量重拉 ~9 个端点（`global-sync.tsx:597-629`）                  | 断线抖动时后端被打满                                         | ⬤ L1 journal replay-first，零 REST 恢复                                                                                                             |
| S6  | **nav 重拉风暴**：每个 `session.updated` debounce 后重拉 scope index + recent + 各分区（`layout.tsx:497-553`） | streaming 期间持续性 REST                                    | ⬤ L3a 事件直接投影                                                                                                                                  |
| S7  | **初始 messages payload 过重**：`GET /messages` 返回全部消息的全部 part（含工具输出全文）                      | 大 session 切换首包可达数 MB，序列化+传输+解析都在关键路径上 | ◐ 新增：快照支持 `partDetail=summary`——渲染窗口（最近 N turn）外的消息只带 part 骨架（类型/状态/首行摘要），展开旧 turn 时按需 `GET /part/:id` 补全 |

### 5.2 前端

| #   | 热点                                                                                                                                        | 量级                                                                        | 解决                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| C1  | **`session.updated` 整对象替换**（`global-sync.tsx:821`）→ `info()` 失效 → 整条派生链+时间线重算（#319）                                    | 每事件一次全链路重渲染                                                      | ⬤ L4.1 reconcile                                                   |
| C2  | **整数组订阅**：`Binary.search(store.session)`、`sync.data.session.find(...)`（`session.tsx:510` 等三处）                                   | 任一 session 的事件 → 所有组件的线性 find 重跑，O(sessions × 订阅点) / 事件 | ⬤ L4.2 normalized key 访问                                         |
| C3  | **part 整对象替换**（`global-sync.tsx:913`）→ 每 delta 重渲染整个 part 组件                                                                 | 流式期间每 chunk 一次                                                       | ⬤ L4.1 part reconcile + L2a delta 追加（只动 text 叶子）           |
| C4  | **每个事件跑一遍 460 行 switch**，含非当前 scope 的 part 洪峰                                                                               | 主线程持续被无关事件占用                                                    | ⬤ L2d 过滤 + L4.3 reducer 分发表；`stream` 类 batch 应用           |
| C5  | **每条 `message.updated` 触发 inbox/cortex REST 重拉**（`refreshVolatileStateAfterMessage`）                                                | streaming 期间反复请求                                                      | ⬤ L4.4 删除，纯事件驱动                                            |
| C6  | **compaction 删光重拉**（`global-sync.tsx:1105`）                                                                                           | 空白帧 + 一次全量 fetch                                                     | ⬤ L5 resyncing 原子换血                                            |
| C7  | **内存无 eviction**：`store.part`/`store.message` 跨 session 永久累积                                                                       | 长会话工作流内存单调增长                                                    | ⬤ L4.5 LRU 桶级释放                                                |
| C8  | **双重 sync + 强制 refreshVolatile**（`session.tsx:471-488`）                                                                               | 每次切换 2×(3-5) 个请求                                                     | ⬤ L5 ensureSession 幂等                                            |
| C9  | 派生链 `messages→rootMessages→visibleRoots→…` 每次消息插入全量 filter                                                                       | O(n)/事件，n≤500，配合 C1/C4 修复后可接受                                   | ◐ 保留现状；若未来 n 上限提高，把 rootID 分组做进 `index` 增量维护 |
| C10 | 时间线 DOM：turn 级窗口（`turnStart`，初始只渲染最近 `turnInit` 个 turn）已存在，但**单个 turn 内**（如 blueprint 跑 100 个工具调用）无截断 | 极端 turn 卡顿                                                              | ◐ turn 内折叠/懒展开（UI 层，独立小改动，不在本协议范围强依赖）    |

**量化验收基准**（进入 P0 前先录制 baseline，逐阶段对比）：

- blueprint 10 节点 run：时间线重渲染次数（`info()` re-eval 计数）P0 后应为 0；
- 100KB 流式回复：服务端 part 文件写入次数（P3 后 ≤ 部数×流时长/500ms）、WS 字节数（P3 后降 ≥90%）；
- 断线 10s 重连：REST 请求数（P1 后为 0，命中 replay）；
- 切换 20 个大 session 往返：JS heap 增量（P2 后平稳）。

---

## 6. Edge cases 清单

| 场景                                                 | 处理                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 事件乱序（WS 单连接内理论不乱序，但重连缝隙会）      | 规则 1/3：旧的丢弃，gap 走 replay/resync                                                                                |
| 事件重复（replay 与实时流重叠）                      | 规则 1 按 seq 幂等                                                                                                      |
| 服务端重启导致 seq 回退                              | seq 持久化水位 + 大步长恢复，信封 `epoch` 兜底：epoch 变化 = 强制全量 resync                                            |
| journal 窗口不够（客户端休眠很久）                   | replay 返回 410 → 域级快照 resync，UI 走 `resyncing` 不白屏                                                             |
| optimistic message 与服务端事件竞争                  | 同 id reconcile 吸收；若发送失败，删除本地实体 + 索引项                                                                 |
| 翻页期间头部有新消息                                 | 头部由事件驱动、尾部由游标驱动，互不干扰；`before=<id>` 游标不受头部增长影响                                            |
| session 在别的 scope（跨 scope 跳转）                | `session.tsx:535-544` 的 redirect 保留；bucket 按 scope 隔离，无串扰                                                    |
| archived session                                     | `session.updated(archived)` → reducer 移除实体 + nav 索引项；正在浏览时 UI 显示 archived 态而非崩溃（实体保留只删索引） |
| part 洪峰下的 UI 帧率                                | L2a 服务端 50ms 合并 + L4 客户端 `stream` 类 batch 应用                                                                 |
| 内存增长                                             | L4 规则 5 的 LRU 桶级 eviction                                                                                          |
| home scope 与 directory scope                        | 现有 scopeKey 分桶保留，seq/水位 per-scope                                                                              |
| `session.status` 的 idle 副作用（重拉 inbox/cortex） | 删除；由 `session.inbox.updated` / `cortex.task.*` 事件直接驱动                                                         |

---

## 7. 与 #281 的关系

#281 解决了"一条消息**是什么**"（rootID/visible/includeInContext/origin），本设计解决"消息与其它状态**如何到达前端且保持一致**"。#281 的派生链（`rootMessages → visibleRoots → turns`）原样保留，只是底座从"裸数组 + 无版本写入"换成"normalized store + 闸门"。#319 提到"#281 让问题更可见"——因为派生链把反应面收敛到了 `info()`/`messages()` 两个入口，本设计正是让这两个入口只在真正相关的字段变化时失效。

---

## 8. 分阶段落地

### P0 —— 纯前端 + 两行服务端，消灭用户可见症状（1-2 天量级）

1. `global-sync.tsx:821` 与 `sync.tsx:273` 整对象替换 → `reconcile(info)`；`part` found 分支同理。**（#319 前端根治）**
2. 删除 `session.tsx:312-327` 回写 effect，实现 L6 三层（draft 先用内存 Map，`ephemeral.model` 删除）。**（#318 根治）**
3. 合并双 sync effect 为 `ensureSession`；删除 `refreshVolatileStateAfterMessage`。
4. `publishInfo` 值去重（服务端，纵深防御）。

验收：blueprint run 期间时间线零闪烁（用 #319 的 re-eval 日志法验证）；加载窗口内改 model 后加载完成值不变。

### P1 —— 序列号协议（协议核心）

1. 服务端：scope seq + 事件信封 + 快照信封（messages/session/status/index/inbox/todo/dag）+ journal & replay 端点。
2. 前端：`applyEvent`/`applySnapshot` 闸门 + 四条规则 + `resyncing` 语义；`resyncInstance` 改走 replay-first。
3. SDK 重新生成。

验收：单测覆盖乱序/重复/gap/晚到快照的全部排列；断线 30s 内重连零 REST 恢复。

### P2 —— Store normalize + 状态机 + compaction 换血

1. `State` 重构为 entities/index 形态，reducer 拆表；`session.compacted` 原子换血；游标分页替换 limit。
2. `SessionResource` 状态机替换四套 readiness；LRU eviction。

验收：切换 10 个 session 后内存曲线平稳；compaction 无空白帧。

### P3 —— Nav 投影 + 流式协议 + modelOverride

1. 删除 `layout.tsx:497-553` debounce 重拉，nav store 直接消费 `session.updated`；NavEntry 字段对齐。
2. part delta-first 协议 + 存储 write-behind（S1/S2）+ `class` 标签 + WS 订阅过滤。
3. messages 快照 `partDetail=summary` + 按需补全（S7）。
4. `PATCH modelOverride` 开放，selector 显式选择持久化。

验收：blueprint storm 期间 sidebar 零额外 REST；100KB 流式回复的 WS 字节量下降 ≥90%、part 文件写入次数 ≤ 流时长/500ms；大 session 切换首包体积下降（按 §5.1 S7 基准）。

---

## 9. 文件改动清单（预估）

| 文件                                                | 阶段     | 改动                                                                   |
| --------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `packages/app/src/context/global-sync.tsx`          | P0/P1/P2 | reconcile 修复 → 闸门接入 → 拆 reducers                                |
| `packages/app/src/context/sync.tsx`                 | P0/P2    | ensureSession、状态机、游标分页                                        |
| `packages/app/src/pages/session.tsx`                | P0       | 删回写 effect、删双 sync、readiness 换源                               |
| `packages/app/src/context/local.tsx`                | P0       | 删 ephemeral.model，接 draft 层                                        |
| `packages/app/src/context/composer-intent.ts`（新） | P0       | draft / sessionDefault / effective                                     |
| `packages/app/src/context/store/`（新目录）         | P2       | entities/index/reducers/gate                                           |
| `packages/app/src/context/layout.tsx`               | P3       | 删 debounce 重拉，nav 事件化                                           |
| `packages/synergy/src/bus/index.ts`                 | P1       | seq 盖章 + journal                                                     |
| `packages/synergy/src/server/server.ts`             | P1/P3    | replay 端点、快照信封、WS 订阅过滤                                     |
| `packages/synergy/src/session/index.ts`             | P0/P1/P3 | publishInfo 去重、messages 信封、updatePart delta-first + write-behind |
| `packages/synergy/src/session/processor.ts`         | P3       | 流式 delta 走缓冲通道而非逐 chunk 落盘                                 |
| `packages/synergy/src/server/session.ts`            | P1/P3    | 快照信封、PATCH modelOverride                                          |
| `packages/sdk`                                      | P1/P3    | 重新生成                                                               |

---

## 10. 决策记录（原待决问题，已定案）

1. **seq 持久化粒度**：进程内计数 + 重启后从持久化水位大步长跳跃恢复，信封 `epoch` 字段兜底（epoch 变化 = 客户端强制全量 resync）。不做每次写入持久化。
2. **draft 不持久化到 localStorage**：内存版足以解决 #318；持久化会引入"刷新后草稿还在但用户已忘记"的反直觉。持久语义由 modelOverride 承担。
3. **显式选择自动写 modelOverride**：selector 里的显式选择即持久化为本 session 的 modelOverride，语义清晰且与 channel `/model` 命令完全一致。
4. **journal 窗口**：事件数 4096 条 + 时间 5 分钟双上限；`stream` 类事件不进 journal（丢了由下一条全量 part 锚点自愈）。
