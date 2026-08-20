# Synergy 桌面宠物（Desktop Pet）方案

> 状态：Phase 1 已实施（PR 交付中）
> 日期：2026-08-20
> 范围：`packages/desktop` / `packages/synergy`（素材工具编排）/ 素材规范
> 基线：f7abdd88d2
> 决策记录：[desktop-pet-window](../decisions/implemented/feature/2026-08-20-desktop-pet-window.md)

## 1. 背景与目标

在 Synergy Desktop 上增加一个桌面宠物：透明置顶窗口 + 精灵图（sprite sheet）动画，实时感知 Synergy 运行状态并切换动画（工作/空闲/完成/报错/睡眠等），支持拖拽、气泡、点击反馈。素材由用户先用自然语言与 Synergy 对话生成（品红抠图 8×7 精灵图），桌宠热重载使用。

目标：

- 桌宠窗口：系统级透明、无边框、置顶、不占任务栏，可拖拽。
- 状态感知：实时反映 Synergy session 状态（running / completed / error / idle）。
- 素材闭环：对话 → `openai-image-gen` 生成品红抠图精灵图 → 桌宠热重载。
- 非侵入：不拦截快捷键、不修改系统配置，可随时退出。

## 2. 现状盘点（已核实）

### 2.1 desktop 包（Electron 42）

| 位置                                          | 能力                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/desktop/src/server-manager.ts`      | 已管理本地 Synergy 服务器：URL / port / pid / `/global/health` 健康轮询（250ms 间隔），桌宠发现服务器零成本 |
| `packages/desktop/src/main.ts`                | 主进程管理主窗口 + Tray + unread 角标（dock badge / tray / overlay）                                        |
| `packages/desktop/src/browser-webrtc-host.ts` | 已有 `skipTaskbar: true` 独立 BrowserWindow 先例（远程浏览器窗口），独立窗口架构已验证                      |
| `packages/desktop/src/identity.ts`            | `SYNERGY_DESKTOP_CHANNEL / SERVER_MODE / APP_URL / DEBUG`，未见访问 API 的 token（本机信任待实施时核实）    |

### 2.2 状态感知通道（服务器 SSE）

| 位置                                    | 能力                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/synergy/src/server/server.ts` | `GET /global/event` SSE 事件流，`Bus.subscribeAll` 广播全量事件，30s 心跳，支持 `?stream=delta` 压缩协议（`EventWire`） |
| `packages/synergy/src/session/types.ts` | session 状态枚举：`queued / running / completed / error / cancelled / interrupted`                                      |
| Bus 事件                                | `session.updated` / `session.idle` / `session.error` / `message.part.updated` 等（`packages/synergy/src/bus`）          |

### 2.3 插件边界

插件系统（`docs/plugins/ui-contributions.md`）只能贡献 App 内宿主渲染面（workbenchPanel / messageSlot / composerExtension 等），**不能创建系统级透明置顶窗口**。因此桌宠窗口必须在 `packages/desktop` 主进程实现；插件体系不参与窗口承载。

### 2.4 素材生成能力

`packages/synergy/src/tool/openai-image-gen.ts`（gpt-image-2）已存在，支持 `size`（含自定义 WIDTHxHEIGHT）、`background: auto|opaque` 参数；tool description 已声明可用于 sprite。对话生成精灵图的 LLM 编排链路已具备，缺的是：品红抠图规范 prompt 模板 + 产物校验/热重载。

## 3. 外部调研：桌宠技术范式

| 范式            | 代表                                         | 要点                                                                                                                                                                                              |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 经典精灵图桌宠  | Neko / eSheep / Shimeji                      | 透明置顶窗口 + 精灵图 + 行为状态机                                                                                                                                                                |
| WebView 桌宠    | Desktop Goose                                | Electron/WebView + 交互恶作剧                                                                                                                                                                     |
| AI 状态感知桌宠 | `xiaominaimoyu/desktop-pet-demo`（Tauri v2） | 感知 AI 工具（Claude Code / opencode）状态：15 态动画状态机（thinking / running / waiting / ready / error）、Spritesheet WebP + GIF 双引擎、气泡系统、拖拽/点击/右键菜单、HTTP API + MCP 反向控制 |

跨项目共识：

- 窗口：透明无边框 + always-on-top + skipTaskbar（macOS `transparent:true`；Windows 需 frameless + `WS_EX_LAYERED`）。
- 动画：精灵图 spritesheet 驱动状态机，行 = 动画，帧循环。
- 状态来源三级降级：Hook/事件推送（<50ms）→ SSE/MCP（<100ms）→ 文件/进程监控（1-5s）。
- 素材：AI 生成精灵图 + 品红（#ff00ff）抠图是当前主流做法。

## 4. 方案设计

### 4.1 架构

```
packages/desktop (Electron 主进程)
├── 主窗口（现有）
└── Pet 窗口（新增）: BrowserWindow{ transparent, frame:false, alwaysOnTop, skipTaskbar }
    └── pet.html + sprite-animator.js（精灵图动画引擎 + 状态机）
         ↑ SSE 订阅（主进程转发或渲染进程直连）
GET /global/event?stream=delta ──── Synergy 本地服务器（Bus 广播）
```

实现要点：

- 主进程新增 `pet-window.ts`：创建/销毁 Pet 窗口，生命周期跟随主窗口与服务器健康状态（`/global/health` 已由 server-manager 轮询）。已实施。
- 状态通道：主进程通过 server-manager 的 URL 订阅 `GET /global/event?stream=delta`，将 `session.*` 事件规约为动画状态机输入（`pet-sse.ts` + `pet-state.ts`）。已实施。
- 动画引擎：纯 HTML/JS（无框架）加载 sprite sheet，按 `MOOD_ROW` 映射切行播放（`pet-page.ts`），`image-rendering: pixelated`，与 desktop-pet-demo 同构。已实施。

### 4.2 动画行 ↔ 状态映射（复用 8×7 精灵图规范）

| 行  | 动画                       | Synergy 触发                                 |
| --- | -------------------------- | -------------------------------------------- |
| 1   | Idle（呼吸+眨眼）          | 无活跃 session                               |
| 2   | Happy / Love               | 用户点击 / 交互 / session completed          |
| 3   | Excited / Celebrate        | 里程碑（完成数 / 连续成功）                  |
| 4   | Sleepy（闭眼呼吸，无哈欠） | 空闲超时降级                                 |
| 5   | Working                    | session running / 工具调用（气泡显示工具名） |
| 6   | Angry / Surprised / Shy    | session error / 意外                         |
| 7   | Dragging                   | 用户按住拖拽                                 |

### 4.3 素材生成闭环

1. 用户在 Synergy 对话：「生成一个 XX 桌宠精灵图」。
2. LLM 调用 `openai-image-gen`，prompt 内置品红抠图规范模板（8 列 × 7 行、每帧正方形、纯 #ff00ff 背景、无留白/网格线、角色无品红污染、同行动画连贯、Idle 带呼吸眨眼、Sleepy 只闭眼呼吸）。
3. 产物保存到工作区（如 `.synergy/pet/<角色>.png`），桌宠监听该目录（文件 watch 或素材变更事件）热重载。
4. 若模型输出与网格规范有偏差（尺寸/背景），由脚本做色度抠图 + 等比缩放 + 网格切分校正（Phase 2）。

### 4.4 交互增强（Phase 3）

- 左键拖拽移动（Dragging 行）、点击触发 Happy、右键菜单（隐藏/休眠/切换角色/退出）、气泡消息（工具调用名、错误摘要、完成提示）。

## 5. 分阶段实施

| Phase    | 内容                                                            | 验收                                                          |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| 1（MVP） | Pet 窗口 + SSE 订阅 + 状态机 + 占位素材                         | 窗口透明置顶可拖拽；working/completed/error/idle 动画切换正确 |
| 2        | 素材生成闭环：规范 prompt 模板 + 产物校验/热重载 + 首次生成引导 | 对话生成精灵图 → 桌宠热重载生效                               |
| 3        | 交互增强：拖拽物理、气泡、右键菜单、点击反馈、多角色切换        | 交互流畅，退出/休眠可靠                                       |

> 状态：Phase 1（MVP）已完成并交付。窗口透明置顶可拖拽、SSE 状态订阅、7 态动画映射、点击/拖拽交互、设置持久化（`desktop-pet.json`）、精灵图校验与热重载均已实现并有测试覆盖。Phase 2/3 作为后续迭代。

## 6. 风险与不确定性

- macOS 透明窗口注意 `transparent:true` 的渲染与性能（多窗口合成成本）。
- `GET /global/event` 鉴权方式未在本次调研中核实（desktop 本机信任机制待实施时确认）。
- 事件 → 动画映射的语义细节（如 completed 与 milestone 的区分、error 的降级路径）需在 Phase 1 用真实事件流校准。
- gpt-image-2 输出的网格精度（8×7、每帧正方形、无留白）可能不稳定，需要脚本校正兜底。

## 7. 待确认项

- Phase 2（素材生成闭环）与 Phase 3（交互增强：气泡、右键菜单、多角色切换）为后续迭代，未在本 PR 范围内。
- 默认角色设定（首版占位素材的形象）。
- 素材管线：直接使用模型输出 vs 生成后脚本校正（推荐后者兜底）。
