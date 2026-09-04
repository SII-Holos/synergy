# Decision Record: Boss 会话可从设置页打开 — 无路由账号时自动创建本地 boss 会话

Status: implemented

## Problem

Boss 同事化(见 [2026-09-03 boss-colleague-persona-explicit-delivery](2026-09-03-boss-colleague-persona-explicit-delivery.md))之后,runtime boss 会话只能被动等待 Feishu 消息路由进入,或由用户手动在 App 会话列表中翻找;设置页没有"打开/创建 boss 会话"的入口。更关键的是,当没有启用且可路由的 Feishu 账号(本地/纯 App 环境、未配置渠道账号)时,`boss_mode` 开启后不会有任何 boss 会话被 provision,用户即使想和 boss 同事对话也无从开始。

用户期望:boss mode 设置里应有"打开 boss session"按钮;会话不存在时自动创建。

## Decision

新增幂等的服务端入口 `POST /boss/session/open`(operationId `boss.session.open`;`boss_mode` 关闭时返回 `409 boss_disabled`,`BossSessionOpenError` 映射),由 `BossRuntime.openSession()` 实现,决策顺序:

1. **优先复用账号路由会话**:存在已注册的 channel endpoint boss 会话(启用 Feishu 账号 provision 的 `scope:boss` 会话)时直接返回;
2. **其次复用既有 channel-routed boss 会话**(覆盖本进程启动后账号映射尚未 provision 的情形,经 home scope 扫描);
3. **再复用本地 channel-less boss 会话**(上一次打开创建的);
4. **最后创建本地 channel-less boss 会话**:home scope、`workflow: { kind: "boss", role: "boss" }`、`boss-synergy` primary agent、interactive interaction、标题 `Runtime Boss (本地)`(`LOCAL_BOSS_SESSION_TITLE`),仅首次创建时投递一次性 world-overview 简报。

`ensure()` 仅在"本进程尚无任何已注册账号会话 **且** 配置存在启用且无 `projectDir` 的可路由 Feishu 账号"时补跑——启动/热重载已跑过 `ensure()` 的常态下,每次点击"打开"不重复投递简报。

设置 UI(`BossModePanel`)新增 **Open boss session** 行(按钮,`disabled = !enabled || opening`,打开中显示 "Opening…"):先 flush Runtime 域草稿(`save.saveServerChanges()`——server 在 `boss_mode` 关闭时拒 409,必须先落盘开关/人格草稿),再经 SDK `client.boss.session.open()` 取 `sessionID`,成功后关闭设置弹窗并 `navigate` 到 `/session/{sessionID}`;失败 toast(`openSessionFailed`)。

**R6 渠道范围界定**:显式 `channel_push` 契约的 delivery hint 只注入 `endpoint.kind === "channel"` 的 boss 会话。channel-less 本地 boss 会话没有渠道,回复在 App 内自然可见,不注入渠道契约、不产生任何自动外发面。原"boss-role 会话恒注入 hint"的表述以本次为准。

## Alternatives considered

- **仅返回已有账号路由会话,无渠道就不提供入口** — 否决:用户明确要求"一开始没有就自动 create",本地/无 Feishu 环境也必须能用 boss 同事。
- **为本地会话伪造 channel endpoint 以复用既有路由/推送机制** — 否决:会污染 R6 显式回传边界与渠道元数据(`channelChatId` 等);本地会话无渠道,回复在 App 可见即可。
- **前端直接调创建会话的普通客户端 API** — 否决:创建必须走 runtime provision(boss workflow/persona/简报/agent 白名单),server 权威;UI 一律经生成 SDK 方法。
- **每次 open 都跑 `ensure()`** — 否决:会重复投递 world-overview 简报;仅在无注册会话且配置含可路由账号时补跑。

## Consequences

- 用户在设置页一键打开(或创建)runtime boss 会话;无 Feishu 的本地/纯 App 环境也能使用 boss 同事。
- 打开幂等:同一会话跨点击复用、无重复简报;存在路由账号时优先打开渠道 boss 会话(回复继续走 R6 显式回传)。
- R6 hint 仅面向渠道路由会话,本地会话 UI 内回复;两类 boss 会话的语义边界清晰。
- 新增 server route + SDK 生成物 + App 面板行为均为纯增量;无持久 schema 变更、无迁移脚本,单 PR revert 即回滚。
