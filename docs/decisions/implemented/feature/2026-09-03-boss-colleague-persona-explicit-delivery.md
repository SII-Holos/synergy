# Decision Record: Boss 同事化 — 人格基底/名字记忆/全量管理工具/显式渠道回传

Status: implemented

## Problem

Runtime Boss Mode 是"路由系统"而非"像人的同事入口":人格来源只有静态 `experimental.boss_identity_text` 或内置默认文案,没有名字、没有随对话累积的自我认知;设置页暴露身份长文本与简报间隔输入;boss-synergy 白名单按通配 deny 拒绝了 session 管理、日程、记忆读取与笔记读写工具;渠道回传走自动流式/桥投递,与"只回传有效信息"的目标冲突——boss 无法选择回传内容与时机,回传也没有用户选择的拟人风格。

对标 Grok Bot 的期望是:用户只须选一个性格 + 起一个名字,其余身份/定位靠日常对话持续累积;boss 拥有管理会话、日程、记忆、笔记的工具;所有对外回传都通过显式的渠道工具调用,内容精简、带人格风格。

## Decision

在现有 boss 域(config experimental + builtin-primary 白名单 + boss-prompt/register + channel boss 分支 + BossModePanel + Library HTTP)做最小语义改造,不新建 persona 存储域、不引入 LLM 抽取管线:

- **人格配置模型**(`experimental.boss_persona`,可缺省):`{ preset: "project_manager" | "ops_assistant" }` 或 `{ preset: "custom", formality/conciseness/proactiveness/warmth: 0..1 }`。确定性渲染函数 `renderBossPersona(input): { identityText, reportStyle }` 由内置文案表 + 维度三档描述组合,纯函数、单测锁定长度上限。`boss_identity_text` 保留 schema 与读取:未设置 persona 时作为 custom 人格文本回退;两者皆无 = 原默认同事文案,升级无空白。
- **每轮注入**(boss-role 会话 Layer 2.5):`<boss-persona>`(名字/身份/语气)+ `<boss-report-style>`(汇报风格,来自 preset 或维度推导)+ `<boss-reply-target>`(入站消息渠道锚点,经 `channelDeliveryMetadata` 扩展 `channelChatId` 提供)+ 恒显式 delivery hint("本轮不会自动投递;需要回执必须显式 channel_push")。原 auto/manual 双分支删除。
- **名字**(运行时级单值):`BossIdentity.getBossName()` 读共享记忆库 self 类目、`title="boss_name"`、`search_only` 的 memory 行;`setBossName(name)` 幂等 upsert(空值即删除)。设置 UI 经新增 Library HTTP 路由 `POST /library/memory` + `/library/memory/update`(operationId `library.memory.create/update`,复用 `LibraryDB.Memory.insert/update` + `Embedding.generate`,SDK 再生成)写入;渲染时名字并入人格文本,未命名回退不带名。
- **R6 显式回传**:boss 路由入站消息不再创建 Feishu 流式卡片、不再 `beginForeground`——静默执行(保留状态 reaction 作为轻量反馈);`channel/outbound.ts` bridge 对 `workflow.kind==="boss" && role==="boss"` 的 terminal 直接跳过;`channel_push` 工具的豁免基于**入站消息元数据**而非 endpoint:`channelChatId`/`channelChatType` 随入站消息持久化(provisioned boss endpoint 只存哨兵 `"boss"` chat id),工具默认目标解析到本轮入站 chat,带 `replyToMessageId` 锚点且同账号的回复免 `communication` 询问(应答用户是 R6 主路径);无锚新消息、跨 chat、跨账号主动推送仍询问。worker `boss_report` 内部链路与非 boss 渠道自动回传语义完全不变。R6 delivery hint 只注入 `endpoint.kind === "channel"` 的 boss 会话——设置页打开的 channel-less 本地 boss 会话(`Runtime Boss (本地)`)没有渠道,回复在 App 内可见,不注入渠道契约(见 [2026-09-04 boss-session-open-from-settings](2026-09-04-boss-session-open-from-settings.md))。
- **工具白名单**(boss-synergy):增 allow `session_control`、全部 agenda 工具(schedule/update/cancel/trigger/watch/logs)、`memory_get`、note 读/写套件(list/read/search/write/edit);维持 deny `note_archive`/`note_delete`、task*、文件类、runtime_reload、dag*。base.txt 同步管理工具纪律文案;身份记忆纪律(写 user/relationship/self、edit 不 accumulate、每类限量)强化进纪律块——自动积累复用 Anima 既有 memory 纪律 + world-overview 简报回读闭环,不新增第二套学习管线。
- **热生效**:`runtime/reload.ts` diff `boss_persona` JSON 变化后触发 `BossRuntime.refreshIdentity({ versioned: true })`,保存即热生效。

## Alternatives considered

- **新建独立 persona 存储域/文件** — 否决:用户明确复用共享记忆库;独立存储会造成与既有 self/relationship 记忆的双源漂移。
- **LLM 每轮/后台抽取学习管线** — 否决:成本高且与 Anima 晨醒整理重复;学习走既有 memory 纪律 + 既有简报闭环。
- **保留自动回传 + prompt 约束(混合策略)** — 否决:纯 prompt 无法杜绝噪音回传;显式 channel_push 是唯一外发面才可审计。
- **会话级/账号级名字** — 否决:用户选 self 记忆全局单名;会话级会碎片化"一个同事"心智。
- **note_archive/note_delete 放行** — 否决:协调者不应从渠道执行破坏性笔记操作,且白名单保持最小。
- **channel_push 全免询问** — 否决:会放开越界主动外发边界;只免"本轮入站 chat + 锚定回复 + 同账号"的应答。
- **非 boss 渠道也改显式回传** — 否决:超出请求范围且破坏现有 Feishu/Clarus/GitHub 自动回复体验。

## Consequences

- boss 会话现在是"有名字、有人格、回执可预期"的同事入口:入站后没有任何自动外发,只有显式 channel_push 产生回传;入站 chat 内锚定回复零摩擦,无锚/跨 chat/跨账号主动推送保留审批边界。
- 设置面收敛为 开关/性格/名字 三项;legacy 字段(schema 保留、UI 隐藏)在未设 persona 时仍可回退生效,旧配置升级无数据迁移。
- 名字与人格/偏好正交:名字由设置写入 self 记忆行,对话定位由既有记忆纪律累积,简报回读两者形成闭环。
- 渠道热路径新增 boss-role 守卫;守卫条件为显式 `kind==="boss" && role==="boss"`,非 boss 会话(Feishu 普通/Clarus/GitHub/mailbox)路径与既有测试契约不受影响。
- boss-synergy 获得全量 session_control 与日程/记忆/笔记管理工具——与"boss 自治、用户信任"一致;文档标注 session_control 可作用于任意会话的边界,本期不引入 boss 树守卫(防过度工程)。
- 新增 server 路由与 SDK 生成物为纯增量;无持久 schema 变更、无迁移脚本,单 PR revert 即回滚。
