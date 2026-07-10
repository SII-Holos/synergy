# 运行时性能根治设计：流式热路径、会话运行时状态与资源生命周期

> 状态：已实施（见文末「实施状态」）。
> 背景：全库性能审计（本文 §2 为实证）、issue #281（串行任务 loop 与消息语义正交化，已合入）、PR #329（前端数据同步重构 + 流式写盘 write-behind，已合入）。本文是这两次重构在"运行时资源开销"维度上的收尾工程：#329 修掉了流式的**磁盘写**放大（S1），本文根治剩下的**CPU / 内存 / 网络**放大，以及与重构无关但同样致命的资源生命周期缺失。
> 范围：`packages/synergy/src/session/{index,invoke,processor,manager}.ts`、`packages/synergy/src/bus/*` 与 `server/server.ts` 事件传输边界、`packages/synergy/src/performance/*`、`packages/synergy/src/scope/runtime.ts` / `lsp` / `browser` 生命周期、`packages/app` + `packages/ui` 流式渲染。

---

## 1. 核心结论

Synergy 的高 CPU / 高内存不是单点 bug，而是四个结构性缺陷的叠加：

1. **流式 delta 热路径是 O(N²) 的**：每个 token 块都触发"读盘定位 scope + 全量 part 序列化广播 + 多条自监控指标"，成本随回复长度平方增长，并按客户端数线性放大。
2. **invoke 循环没有内存中的消息态**：每执行一步（每次工具调用）都把整个会话历史从磁盘全量重读一遍，长会话单步可达上千次文件 IO，且每次 IO 又各产生 2~3 条自监控指标（乘法放大）。
3. **重资源没有生命周期**：项目 scope 的 LSP 子进程、会话的 Chromium 浏览器页面，一旦创建就活到 server 进程退出，内存随使用历史单调上涨。
4. **自监控系统是全局固定税**：默认全采样 + sqlite/JSONL 双写 + 每条指标 Zod parse + 每行 insert 重新 prepare，作用在上面每条热路径上。

关键判断：**#281 和 #329 落地之后，前两个问题第一次变得"可根治"了**——单活跃 loop 不变式（I1）让会话运行时内存态有了合法的单写者；#329 的序列协议明确把流式事件定义为"可合并、自愈（后续会有完整 part 跟上）"，让传输层可以合法地只发 delta。本文方案完全构建在这两个已合入的契约之上，不需要新的破坏性语义变更。

---

## 2. 现状诊断（实证）

### 2.1 H1：流式 delta 热路径 O(N²)

LLM 流式期间，每个 `text-delta` / `reasoning-delta` 触发以下完整管线：

| 步骤                                  | 代码                                                                                                       | 单 delta 成本                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 记录 `llm.stream.output_chars` 指标   | `session/processor.ts:1039`（text）、`:717`（reasoning）                                                   | 1 条 metric（Zod parse + id + ISO + label 脱敏 + 入队） |
| `Session.updatePart` 重新定位 session | `session/index.ts:958` → `SessionManager.requireSession` → `manager.ts:106-116`                            | **2 次磁盘 JSON 读**（sessionIndex + sessionInfo）      |
| 每次 Storage 读的自监控               | `storage/storage.ts:141-186`（`measureStorage`）                                                           | 每读 2 条 metric，共 4 条                               |
| Zod 校验                              | `session/index.ts:955`（`fn(UpdatePartInput)`，union 首成员是完整 `MessageV2.Part` union）                 | 常数偏大的对象校验                                      |
| 全量 part 广播                        | `session/index.ts:974` `Bus.publish(PartUpdated, { part, delta })`，part 携带**全量累积文本**              | 见下                                                    |
| WS 编码                               | `server/server.ts:575` `JSON.stringify(event)` 后发给**所有** `/global/event/ws` 客户端（不按 scope 过滤） | O(累积文本长度) 的序列化 + 每客户端 O(N) 网络字节       |
| SSE 编码                              | `server/server.ts:1306` `/event` 路由 `Bus.subscribeAll` 内**每客户端各 stringify 一次**                   | 每客户端 O(N) CPU                                       |

量化：一条最终 60KB、拆成 1500 个 delta 的回复，仅 WS 载荷累计 ≈ 45MB/客户端（N²/2），外加 3000 次文件读、约 7500 条 metric。前端每个 delta 还要 `JSON.parse` 全量 part（O(N²) 总量），desktop 同样成立。

对照组：磁盘写侧已被 #329 的 `PartWriteBuffer`（`session/part-write-buffer.ts`，500ms 合并）修复；工具参数流有 50 字符节流（`processor.ts:780`）；**文本流的 CPU/网络侧完全没有等价处理**。

### 2.2 H2：invoke 循环每步全量重读会话

`invoke.ts:205` 的 `while(true)` 循环体每步执行 `effectiveCompactedMessages(sessionID)`（`invoke.ts:1574`）→ `Session.messages` → `history.ts:277`：

- `message-v2.ts:1088` `stream()`：scan 消息目录 + 逐条 `get()`；每条消息再 scan parts 目录 + `readMany` 全部 part 文件（`message-v2.ts:1113`）；
- `invoke.ts:242` 每步还有一轮 `SessionHistory.storedInfo`（再次 scan + readMany 历史事件）。

一个 500 消息的会话，每步 ≈ 1000+ 次 readdir/文件读 + 全量 JSON.parse + `deriveSemantics` + `toModelMessage` 重建；30 步的 turn 就是 3 万+ 次文件 IO。**没有任何消息内存缓存层**。每次 Storage 操作又各产生 2~3 条 metric（§2.5 的税与本条相乘），单步可瞬间产生数千条 metric，直逼 `performance/store.ts:24` 的 `MAX_PENDING=10_000` 队列上限并触发 `Array.shift()` 逐条挤出。

### 2.3 H3：前端流式全文 Markdown 重渲染

`ui/src/components/markdown.tsx:170-215`：`text` 每次变化（流式期间由 `app/src/context/global-sdk.tsx:39-62` 合并到约 16ms 一次）都对**全文**执行 `checksum` + `marked.parse`（含 shiki 高亮、katex），然后整块替换 `innerHTML` 并重跑 `enhanceMarkdown` 的全量 DOM 遍历。长回复流式期间是 O(N²) 的浏览器主线程 CPU。HTML cache（200 条 LRU）在流式期间必然 miss（hash 每次都变）。

### 2.4 H4：重资源没有生命周期

- **scope 运行时永不闲置回收**：`scope/runtime.ts:17-50` 的 `started` Map 只在 server 关机（`server/server.ts:661`）、config 变更（`config/config.ts:966`）或显式 CLI 命令时清理。scope 启动即拉起 Plugin / LSP / FileWatcher / Vcs。
- **LSP 子进程只增不减**：`lsp/index.ts:220-235` 按 root×server 拉起语言服务器子进程（tsserver 等单个可达数百 MB RSS），仅在子进程自身退出时从列表移除，无 idle 关停。用户开过的每个项目都让这些子进程常驻。
- **Browser 会话从不释放**：`browser/runtime.ts:107-118` 的 `disposeSession` 与 `stop()` **在全代码库没有任何调用方**；每个用过 Browser workspace 的会话对应一个 Playwright page/context（Chromium renderer ≈ 100~300MB），累积到 server 退出。
- 对照组（已有正确范式）：`session/manager.ts:63-81` 的 SessionRuntime 有 30 分钟 TTL + 5 分钟 sweep；`process/registry.ts:243` 有 TTL sweeper。**缺的不是机制，是把同一范式套到 scope/LSP/browser 上。**

### 2.5 H5：自监控固定税

- 每条 metric 都过 Zod parse（`performance/metrics.ts:33`）+ `JSON.stringify(labels)`。
- sqlite 每行 insert 都 `conn.prepare(...)` 重新编译语句（`performance/store.ts:75-78`）——bun:sqlite 只有 `query()` 带语句缓存。
- 默认双写：sqlite + JSONL mirror 同时开启，`samplingRate` 默认 1（`performance/config.ts:41-87`）。
- 每次 Storage 操作固定 2~3 条 metric（`storage/storage.ts:141-186`）；每个 HTTP 请求 span + 2~3 条 metric + 1 行 JSONL + 1 条 INFO 日志（`server/server.ts:380-430`），日志每行 `writer.flush()` 一次 syscall（`util/log.ts:119-122`）。

单项都不大，但作用在 H1/H2 被放大的路径上，是乘法项。

### 2.6 H6：次要项清单

| 问题                                                            | 代码                                                                                                                          | 影响                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 每步两次 git 快照                                               | `processor.ts:926`（start-step）、`:963`（finish-step）→ `snapshot.ts:160-206`（shadow git dir 的 refreshIndex + write-tree） | 大仓库单步秒级 CPU；每会话独立 object store 磁盘累积             |
| `Storage.write` 双重 stringify + TextEncoder 全量分配只为计字节 | `storage/storage.ts:98`、`:189-191`                                                                                           | 大 part 写放大；`Buffer.byteLength` 可免分配                     |
| Stats 按需全库扫描                                              | `stats/engine.ts:121-137`、`stats/aggregator.ts:28`                                                                           | 打开统计页即全量读所有 scope 全部消息                            |
| Observability query 全文件读入                                  | `observability/index.ts:95-117`（`Bun.file(file).text()`，单目录上限 250MB）                                                  | 诊断 API 一次调用数百 MB 瞬时分配                                |
| PromptBudgeter 首步全量 tiktoken                                | `session/prompt-budgeter.ts:153-160`                                                                                          | 200k token 历史秒级 CPU（后续步已有 calibration 短路，设计正确） |

### 2.7 已检查、确认无恙（排除嫌疑，避免重复排查）

事件重放 journal 有界（`bus/sequencer.ts:23-25`，4096 条/5 分钟）；`util/lock.ts` 空锁即删；PerformanceStore 队列有界 + sqlite 250MB 上限 + 保留期删除；pty 输出 2MB 上限、指标 1s 节流（`process/pty.ts:148-166`，可作为 H1 修复的节流范式）；前端消息/part store 有 LRU 逐出（`app/src/context/global-sync.tsx`，#329 P3）；markdown HTML cache 有界；Project Scope 默认启用 workspace file watcher，`SYNERGY_DISABLE_FILEWATCHER` 是诊断逃生口；各类 setInterval 基本 `unref` 且成对清理。

File workbench 采用分层有界模型：Server 的目录接口先对 `Dirent` 轻量过滤、目录优先自然排序和分页，只为当前页以固定 16 并发解析 Node；Git 状态请求构建一次 path map。Frontend 同一目录最多一个请求在途，目录请求并发 6、文档读取并发 3；文档内容最多 24 个或约 32 MiB，Monaco model 最多 12 个或约 24 MiB，Explorer 最多 25,000 个已加载节点。Tree 通过 `virtua/solid` 只挂载可视行与 10 行 overscan。Watcher 默认忽略 `.git`、`node_modules` 和构建产物等高成本路径，并按父目录 50 ms 合并事件；重新聚焦、手动刷新和重新展开目录仍会做验证，因此正确性不依赖 watcher 可用性。

---

## 3. 为什么现在可以根治：#281 / #329 提供的架构前提

本设计**不引入新语义**，只是把两次已合入重构的既有契约推到运行时层：

1. **I1 单活跃 loop（#281）**：每个 session 同时最多一个活跃 loop（`SessionManager.acquire`）。这意味着 loop 运行期间，**loop 是该会话消息的唯一写者**——在内存中维护消息态是合法的，不存在并发写者使缓存失效的问题。#281 之前 mailbox/inbox 双缓冲、parent 漂移使"会话内存态"无法定义；现在可以。
2. **流式事件的"可合并、自愈"契约（#329）**：`bus/sequencer.ts:1-9` 明确声明流式事件不参与 seq/gap 检测，"they are coalescible and self-healing (a full part follows)"。这个契约意味着**传输层丢弃或改写流式事件的载荷是被协议允许的**——只要保证"完整 part 随后到达"。delta-only 线格式 + 周期性 checkpoint 正是这个契约的直接推论。
3. **PartWriteBuffer 的 500ms 节拍（#329）**：磁盘 write-behind 已经在 500ms 边界产出"当前完整 part"，线上的 full-part checkpoint 可以**复用同一节拍与同一份数据**，不新增状态机。
4. **seq/epoch + replay + 快照水位（#329）**：重连后的一致性已由状态事件协议兜底，流式载荷不需要承担"每帧自包含"的职责。
5. **ACP 侧已按 delta 消费**（`acp/agent.ts:321,339` 读 `props.delta`），说明 delta-first 的消费模式已有先例。

---

## 4. 目标模型

### D1：流式传输协议——delta 帧 + checkpoint 帧（根治 H1 的网络/序列化侧）

**原则：进程内 Bus 语义不变，只改传输边界。** 进程内订阅者（`tool/task.ts:214`、`cortex/manager.ts:272`、`channel/index.ts:490`、ACP）拿到的是对象引用，无序列化成本，不受影响。

- `Bus.publish(PartUpdated, { part, delta })` 保持现状（进程内引用传递）。
- 在 GlobalBus → WS（`server.ts:573-585`）和 Bus → SSE（`server.ts:1297-1310`）的**编码边界**引入流式帧改写：
  - **delta 帧**：`{ type: "message.part.delta", properties: { sessionID, messageID, partID, kind: "text"|"reasoning"|"tool-raw", delta } }` —— 流式事件（`def.streaming === true` 且带 `delta`）只发这个，载荷 O(delta)。
  - **checkpoint 帧**：完整的 `message.part.updated`（现有格式），在两个时机发出：① `PartWriteBuffer` 的 500ms flush 节拍（与磁盘落盘共用同一份完整 part）；② 终态写入（`updatePart` 无 delta 分支，现状就是完整 part）。
- 客户端（`app/src/context/global-sync.tsx:946`）：delta 帧对 `store.part[messageID][i].text` 做 append（Solid store 细粒度更新，正好命中 #329 P0.1 的 reconcile 设计意图）；checkpoint / 终态帧走现有 reconcile 路径覆盖纠偏。**乱序/丢帧不需要处理**：500ms 内必有 checkpoint 覆盖，与 #329 的自愈契约一致。
- **兼容性开关**：编码边界按客户端能力协商（连接 query 参数 `?stream=delta`，或一个 server 配置项）。旧 SDK / 未升级客户端继续收全量 part（现状行为），新前端/CLI 切 delta。ACP 消费端已兼容。
- 顺带修复：WS 广播当前把**所有 scope**的事件发给**所有客户端**（`server.ts:576`），delta 帧改写时同步加 directory 过滤（客户端在 `global-sdk.tsx` 本来就按 directory 分发，服务端过滤纯属带宽节省）。

效果：线上载荷从 O(N²/2) 降到 O(N)+O(N/500ms 个 checkpoint)；server 序列化、客户端 parse 同步降为 O(N)。

### D2：SessionRuntime 消息态——运行期单写者缓存（根治 H1 的读盘侧 + H2）

在 `SessionManager.SessionRuntime` 上挂运行期状态（仅活跃 loop 期间存在，随 runtime 的既有 TTL sweep 一起回收）：

```ts
interface SessionRuntime {
  // ...现有字段
  ctx?: {
    scopeID: string // 消灭 updatePart 每 delta 两次读盘
    messages: MessageV2.WithParts[] // loop 的工作副本，单写者 = loop 自身
    dirty: boolean
  }
}
```

- **updatePart 免读盘**：`session/index.ts:958` 的 `requireSession` 改为先查 `runtime.ctx.scopeID`（loop 启动时填充）；miss 才回落磁盘（外部单发 updatePart 的场景）。每 delta 的 2 次文件读 + 4 条 metric 归零。
- **loop 增量维护**：`invoke.ts:205` 每步不再 `effectiveCompactedMessages` 全量重读。loop 启动时读一次磁盘建立 `ctx.messages`；此后 processor 产生的每个 message/part 写盘的同时 append/patch 进 `ctx.messages`（processor 本来就持有这些对象，只是现在扔掉再从磁盘读回来）。inbox 注入（steer/context 物化）同样双写。
- **校准点**：每步开始时只重读**可能被外部改写**的轻量数据：session info（1 次读）+ inbox（已有）。rollback/unrollback、`/compact`、消息删除等旁路写入都要求 session idle（`SessionManager.assertIdle`），**在 I1 下不可能与活跃 loop 并发**，因此不会使缓存失效；唯一例外是 compaction 由 loop 自身发起，属于单写者内部操作，同步更新 `ctx.messages` 即可。
- **失效兜底**：任何 `ctx` 与磁盘不一致的疑虑场景（异常恢复、跨进程写）直接 `ctx = undefined` 退回全量重读——性能优化失效退化为现状，不产生正确性风险。
- turn 结束（release）时清空 `ctx.messages`（保留 scopeID 到 runtime TTL 到期），避免长驻内存。

效果：长会话每步磁盘 IO 从 ~1000 次降到 ~2 次；step 间 GC 压力（整份历史对象图/步）消除；§2.5 的乘法税基（metric 条数）同步坍缩。

### D3：资源租约与闲置回收（根治 H4）

把 `SessionManager` 的 sweep 范式提炼为统一模式，套到三类重资源上：

1. **LSP idle 关停**：`lsp/index.ts` 的每个 client 记录 `lastUsedAt`（`touchFile`/请求时刷新）；scope 级 sweeper（15 分钟间隔）关停闲置超过 `lsp.idleTimeoutMs`（默认 30 分钟，可配）的子进程。client 列表本来就支持进程退出后按需重新 spawn（`lsp/index.ts:220-235` 的 find-or-create），**关停即恢复到"未 spawn"状态，无需新恢复逻辑**。
2. **scope 运行时闲置释放**：`scope/runtime.ts` 的 `started` Map 配 `lastActiveAt`（`ScopeRuntime.provide` 进入时刷新）；无活跃 session（`SessionManager.listRunningRuntimes` 为空）且闲置超阈值（默认 2 小时）的 scope 调用现有 `ScopeRuntime.dispose(scopeID)`——disposal 路径（watcher unsubscribe、plugin 卸载、`scope.runtime.disposed` 事件、客户端 resync）**在 config 变更场景已被验证**，只是从未被闲置触发过。
3. **Browser 会话回收**：接线两个本就该存在的调用方——① session archive/delete 时调用 `BrowserRuntime.disposeSession(owner)`；② browser 级 idle sweeper（无 host 连接且无工具活动超过 30 分钟即 dispose；Browser context/storage state 本来就按 owner 持久化，重开会话时页面按"首次导航创建"的既有语义重建）。server 关机路径补 `BrowserRuntime.stop()`。

### D4：观测降税（根治 H5）

1. **热路径聚合**：`storage.operation.*` 改为进程内聚合器（按 operation×keyPrefix 累加 count/duration 直方图），1s 定时冲刷为聚合 metric——范式即 `process/pty.ts:148-166` 的现成实现。`llm.stream.output_chars` 同样按秒聚合。效果：H1/H2 场景 metric 条数下降 2~3 个数量级。
2. **语句缓存**：`performance/store.ts` 的 5 个 `insertXxxSync` 改用 `db.query()`（bun:sqlite 内建语句缓存）或模块级 lazy prepared statement。
3. **内部记录免 Zod**：`PerformanceMetrics.record` 的输入全部来自内部代码（类型已由 TS 保证），`schema.parse` 改为仅在 ingestion 边界（browser batch）保留，内部路径直接构造对象。
4. **默认单写**：`jsonlMirrorEnabled` 默认改 `false`（JSONL 保留为支持包/兼容场景的显式开关；`docs/performance-observability.md` 同步更新）。
5. **队列挤出改环形**：`MAX_PENDING` 溢出时 `pending.shift()`（O(n)）改环形缓冲或批量丢弃计数。

### D5：前端流式渲染（根治 H3）

> 参考：[Render LLM responses — Chrome for Developers](https://developer.chrome.com/docs/ai/render-llm-responses)。该文把"每 chunk 全量 `innerHTML` 替换（重解析 + 重高亮 + 整树重渲染）"点名为反模式（即 H3 的现状），推荐**流式 Markdown 解析器**——以 `appendChild` 增量产出 DOM 节点，每 chunk 只做 O(delta) 的 DOM 工作（参考实现：[`streaming-markdown`](https://github.com/thetarnav/streaming-markdown)，`smd.parser_write(parser, chunk)`）。本节按此修订。

- **流式阶段：增量解析 + DOM append**。part 处于 streaming 状态（无 `time.end`）时，`Markdown` 组件切换为流式解析器模式：delta 直接喂给增量解析器（`streaming-markdown` 或等价实现），解析器向 ref 容器 `appendChild`，**不跑 marked/shiki/katex、不动 innerHTML**。用户在流式期间即可看到段落/加粗/列表/代码围栏等结构（代码块此阶段为无高亮的 `<pre><code>`；表格与 katex 公式此阶段以原文呈现，属可接受的过渡态）。与 D1 天然咬合：delta 帧的载荷就是解析器的输入；兼容模式（全量 part）下客户端也可自行求增量——流式期间 `text` 是 append-only 的，`delta = text.slice(prev.length)`。
- **终态阶段：一次性完整渲染**。`text-end`（终态 checkpoint 到达）后，用现有 marked + shiki + katex 管线做一次完整渲染替换流式 DOM，并只在此时跑一次 `enhanceMarkdown`（copy 按钮、表格包裹、katex 交互）。视觉保真度与现状一致，成本从"每 16ms 一次 O(N)"降为"全程 O(N) 一次 + 流式期间 O(delta)/帧"。
- **纯文本路径同理**：非 markdown 的流式文本（工具原始输出等）用 `append(chunk)` / `insertAdjacentText("beforeend", chunk)` 追加，避免 `textContent +=`（每次移除并重建文本节点，Chrome 文档同样点名）。
- **节流保持**：`global-sdk.tsx` 既有的 ~16ms 合并窗口保留，作为解析器喂入节拍。
- **安全边界（随本节一并修复）**：现状 `marked.parse` 的输出未经任何 sanitize 直接进 `innerHTML`（`ui/src/context/marked.tsx` 全文无 DOMPurify/escape，marked 默认放行原始 HTML），而 SPA CSP 的 script-src 含 `'unsafe-inline'`（`server/server.ts:115-126`）——模型/工具/网页内容中的 `<img onerror=...>` 会实际执行，属于 XSS 面，Chrome 文档明确要求把 LLM 输出当用户生成内容对待。修复：终态渲染输出过 DOMPurify 后再进 innerHTML（每消息一次，O(N)，不在热路径）；流式阶段增量解析器只构造白名单元素、不透传原始 HTML，天然免疫。注意**不要**照搬该文"每 chunk 对累积缓冲全量 sanitize"的示例——那本身是 O(N²)，与本设计的 O(delta) 目标冲突且没有必要（我们只在产出 HTML 的终态点 sanitize 一次）。

### D6：杂项修复清单（随 P2 顺带）

1. Snapshot：start-step 的 `Snapshot.track` 保留（工具执行前的还原点语义必需），finish-step 的 track+patch 改为**仅当本步有工具执行**时进行（纯文本步跳过）；shadow git dir 增加会话删除外的定期清理（复用 D3 的 sweep）。
2. `Storage.write`：删除重复 stringify，`byteLength` 改 `Buffer.byteLength(str, "utf8")`。
3. `Observability.query`：改为按行流式读（`readline` / chunk 扫描），去掉整文件 `.text()`。
4. Stats 全库扫描：加结果缓存（rollup 已有雏形）+ 后台增量，不在本设计展开。

---

## 5. 不变式

- **R1（协议自愈）**：任一时刻客户端错过任意数量的 delta 帧后，最迟 500ms 内一个 checkpoint 帧使其 part 状态收敛到服务端状态。终态帧必达（复用状态事件的 seq/replay 通道语义不变）。
- **R2（单写者缓存）**：`runtime.ctx.messages` 仅在该 session 的活跃 loop 内被读写（I1 保证）；任何非 loop 路径的会话写入要求 idle，因此与缓存生命周期互斥。缓存不确定即丢弃，退化为磁盘全量重读。
- **R3（磁盘为真）**：内存态永远是磁盘态的加速视图；所有写仍然先走 Storage（含 write-behind），崩溃恢复语义与现状完全一致（#327 的 flush 契约保持）。
- **R4（回收即未创建）**：LSP / scope / browser 被闲置回收后的系统状态，与"从未创建过"在可观察行为上等价（下次使用按需重建）；回收绝不发生在资源正被使用时（活跃 session / 连接中的 host / 进行中的 LSP 请求均使 `lastUsedAt` 刷新）。
- **R5（观测不改语义）**：D4 只改变指标的粒度与传输，不减少可观测面——聚合后的 count/duration 仍可回答现有 Performance 面板的全部查询。

---

## 6. 分阶段落地与验收

度量统一用现有 `/global/performance` 面板 + `perf:load` / `perf:benchmark`（`script/performance-*.ts`），每阶段前后各采一轮基线。

| 阶段    | 内容                                                                     | 验收指标                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0a** | D2 的 scopeID 缓存（updatePart 免读盘）+ D4.1 热路径聚合 + D4.2 语句缓存 | 流式期间 `storage.operation.count`（keyPrefix=session_index/sessions）≈ 0；metric 写入速率下降 ≥ 90%；单条长回复流式期间 server CPU 采样（`process.cpu.utilization`）显著下降 |
| **P0b** | D1 delta 帧 + checkpoint 帧（含兼容开关、WS directory 过滤）             | 60KB 回复的 WS 出口字节从 ~45MB 降到 < 200KB/客户端；前端 long task（`frontend.long_task.duration`）流式期间下降                                                              |
| **P1a** | D2 完整版（loop 消息态、增量维护、校准点）                               | 500 消息会话单步 `storage.operation.count` 从 ~1000 降到 < 10；30 步 turn 的 wall time 改善可测                                                                               |
| **P1b** | D5 流式增量渲染（streaming parser + 终态完整渲染 + DOMPurify）           | 流式期间浏览器主线程 long task 消除；INP 不劣化；Paint flashing 验证仅追加区域重绘                                                                                            |
| **P2**  | D3 三项生命周期 + D6 杂项                                                | 8 小时多项目使用后：LSP 子进程数 = 活跃项目数；无 Browser 使用时 Chromium renderer 数归零；`process.memory.rss` 长时稳态不再单调上涨                                          |
| **P3**  | D4.3/4.4/4.5 收尾 + 文档（`performance-observability.md`）更新           | quality gate 全绿；默认配置下 JSONL 目录不再增长                                                                                                                              |

P0a/P0b 相互独立、与 P1 无依赖，可并行小 PR 落地（沿用 #329 的 landed-in-small-commits 方式）。

---

## 7. 兼容性与风险

| 风险                                    | 缓解                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 旧客户端依赖每帧全量 part               | D1 有协商开关，默认对未声明能力的连接保持现状格式；灰度一个版本后翻转默认值                                         |
| `ctx.messages` 与磁盘漂移导致上下文错误 | R2/R3：任何疑虑即丢缓存退化重读；P1a 附带一个 debug 断言模式（每步抽样比对内存态与磁盘态 hash），soak 后移除        |
| LSP/scope 回收误伤活跃使用              | R4 的 `lastUsedAt` 刷新点覆盖所有入口（provide / touchFile / host 连接 / 工具调用）；阈值可配，首发保守（30min/2h） |
| Browser dispose 丢失页面状态            | Browser storage state 本按 owner 持久化；dispose 只丢"当前打开的页面"，与 server 重启后的既有行为一致               |
| 观测聚合后丢失单事件排查粒度            | span/trace 路径不变（本设计只聚合 count/duration 型 metric）；JSONL 关闭后仍可显式开启                              |

## 8. 关联

- issue #281 —— 本设计依赖其 I1 单活跃 loop 不变式（D2 的正确性基础）。
- PR #329 —— 本设计是其"perf hotspot S1（磁盘写）"修复在 CPU/网络/内存维度的对偶收尾；D1 直接建立在其流式事件自愈契约与 write-behind 节拍上。
- `docs/performance-observability.md` —— 观测相关字段说明。

---

## 9. 实施状态

代码为准；下表记录各设计项的落地情况与偏离原因。

| 项                                         | 状态           | 落地位置 / 备注                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** 流式 delta 帧 + checkpoint          | 已实施         | `server/event-wire.ts`（per-encoder，checkpoint 节流 1s + 首帧/终态全量），`server/server.ts` WS/SSE 边界按 `?stream=delta` 协商并共享序列化，`app/context/global-sdk.tsx` 客户端接入，`global-sync.tsx` delta 追加到 `.text` 叶子。WS directory 过滤未做（客户端本就按 directory 分发，需要客户端上报订阅集，留待后续）。 |
| **D2-1** updatePart scopeID 缓存           | 已实施         | `session/manager.ts` 的不可变 `sessionID→scopeID` 缓存；`updatePart` 免每 delta 两次读盘。                                                                                                                                                                                                                                 |
| **D2-2** loop 单写者消息态缓存             | 已实施         | `session/message-cache.ts`（loop 作用域、不可变维护）；`history.ts:rawMessages` 读缓存；`index.ts` 的 updatePart(终态)/updateMessage 维护、removal/compaction/delete 失效；`invoke.ts` enable/disable。`SYNERGY_VERIFY_MESSAGE_CACHE` 校验模式全量测试零漂移；`SYNERGY_DISABLE_MESSAGE_CACHE` 逃生阀。                     |
| **D3** LSP / Browser 生命周期              | 已实施         | LSP：`lsp/index.ts` per-scope sweeper（30min idle，`SYNERGY_DISABLE_LSP_REAP`）。Browser：`browser/runtime.ts` GlobalBus reaper（session 删除/归档即 dispose）。                                                                                                                                                           |
| **D3** scope 运行时闲置释放                | 未实施（有意） | scope disposal 路径重（watcher/plugin 卸载 + 客户端 resync），闲置误伤风险高；LSP reaping 已覆盖 scope 运行时的主要内存（语言服务器子进程）。留待单独评估。                                                                                                                                                                |
| **D4-2** insert 语句缓存                   | 已实施         | `performance/store.ts` 五条写路径改 `db.query()`。                                                                                                                                                                                                                                                                         |
| **D4-3** 内部 metric 免 Zod                | 已实施         | `performance/metrics.ts:record` 直构对象。                                                                                                                                                                                                                                                                                 |
| **D4-1** 热路径指标聚合                    | 未实施（有意） | dashboard 用 `storage.operation.duration` 逐条值算 p95（R5），预聚合会丢分位。D2-1/D2-2 已从源头消除流式期间的高频 storage 指标，本项收益随之大幅下降。`llm.stream.output_chars` 的按秒聚合留待后续。                                                                                                                      |
| **D4-4** jsonlMirror 默认关                | 未实施（无效） | `storage.jsonlMirrorEnabled` 为无消费方的死配置，改默认值无效果；未改动以免误导。                                                                                                                                                                                                                                          |
| **D4-5** 队列溢出改批量丢弃                | 已实施         | `performance/store.ts:enqueue` 溢出时按批 splice，摊还 O(1)。                                                                                                                                                                                                                                                              |
| **D5** 流式增量渲染                        | 已实施         | `ui/components/markdown.tsx`（`streaming` 时 `streaming-markdown` 增量 append，终态 marked+shiki+katex 完整渲染），`message-part.tsx` 传入 streaming 标志。                                                                                                                                                                |
| **D5** 输出 sanitize（XSS）                | 已实施         | `ui/components/markdown-sanitize.ts` DOMPurify（终态一次），jsdom 用例覆盖。                                                                                                                                                                                                                                               |
| **D6** Storage 重复 stringify / byteLength | 已实施         | `storage/storage.ts` 单次序列化 + `Buffer.byteLength`。                                                                                                                                                                                                                                                                    |
| **D6** finish-step 快照跳过                | 未实施（有意） | 纯文本步跳过 patch 会漏记并发文件改动（长运行 bash 等），破坏还原历史，风险大于收益。                                                                                                                                                                                                                                      |
| **D6** Observability.query 流式读          | 未实施         | 仅诊断支持 API，非热路径，内存尖峰受 250MB 文件上限约束；优先级低。                                                                                                                                                                                                                                                        |
| **D6** Stats 全库扫描缓存                  | 未实施         | 本设计明确不展开。                                                                                                                                                                                                                                                                                                         |
