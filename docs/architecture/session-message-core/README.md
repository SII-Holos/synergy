# Session 核心重构：细化设计文档集

总纲：[`../session-message-core.md`](../session-message-core.md) · Issue：SII-Holos/synergy#281（含两条设计补充评论：撤回/rewind 机制、context mode piggyback 规则）

| 文档                                                         | 内容                                                                                                      | 主要对应代码                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [01-message-assembly.md](./01-message-assembly.md)           | 后端消息组装管线：落盘层 → 有效视图 → 调用投影 → system 拼装；排水点与 piggyback；字段消费对照与伪代码    | `session/invoke.ts`、`message-v2.ts`、`llm.ts`、`history.ts`、`compaction.ts`             |
| [02-frontend-message-sync.md](./02-frontend-message-sync.md) | 前端拉取/分页/增量事件存档；渲染派生层从四重启发式换成 rootID/visible/origin；pending 消息进时间线        | `app/context/sync.tsx`、`global-sync.tsx`、`app/pages/session.tsx`、`ui/session-turn.tsx` |
| [03-undo-rewind-frontend.md](./03-undo-rewind-frontend.md)   | 统一撤回交互：pending 撤回与 rewind 的完整规格、确认弹层、回退横幅、冻结呈现、状态机、组件与 API 改动清单 | `app/components/session/commands.tsx`、`session-inbox.tsx`、新增 dialog/banner 组件       |

约定：三份文档均先存档现状（含 `file:line`）再写目标态，作为 Phase 2 各 PR 的实现依据与回归对照。
