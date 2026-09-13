# Decision Record: Strict data-URL decoding pairs with standard base64 producers and parked inbox task failures

Status: implemented

## Problem

前端把拖拽 session/note 附件编码为 `data:text/plain;base64,` 前缀拼接 `base64Encode` 的输出，但该 helper 是 URL-safe base64（`+`→`-`、`/`→`_`、去 padding）。后端在 #1349 把 `Attachment.decodeDataUrl` 收紧为 WHATWG fetch spec 的严格实现后，payload 一旦含 `-_`（长文本几乎必然）就会在物化时确定性抛 `InvalidUrlError`——同样的错配在宽松解码时代潜伏了四个月。

故障路径由 #1362 的唤醒重试链放大：`InvalidUrlError` 被刻意保持可重试（steer/context 条目会在物化前被消费掉，错误在条目删除后才出现），但 task 条目物化失败后仍留在收件箱，确定性错误让 5 次退避重试必然全败，链静默放弃；后续每条新消息入队又触发同样失败的唤醒链。条目既不展示失败状态也没有重试入口，UI 表现为"turn 结束后挂起、新消息发不进去"，重启也无法恢复（startup recovery 走同一条链）。

## Decision

三处共同收口：

1. **编码端**：`packages/util` 新增 `base64EncodeStandard`（RFC 4648 标准字符集 + padding）；四处 data-URL 生产点（session-command 两处、submit 两处）切换过去。`base64Encode` 保持 URL-safe 语义，继续服务 URL 路由段等需要 URL 安全字符集的调用方。
2. **解码端**：`decodeDataUrl` 的 base64 分支按 forgiving-base64 归一化——URL-safe 字符映射回标准字符集并重新推导 padding。已滞留的历史消息无需迁移即恢复可解码。
3. **收件箱**：`SessionInbox.Item` 增加可选 `status: "failed"` 与 `failReason`。task 物化遇到 `InvalidUrlError` 时停靠为 failed 并持久化发布，不抛出、不删除；`peekTask`/`hasRunnableItem`/startup discovery 跳过 failed 条目，队列后方的任务继续消费。`materializeNextTask` 收口 loop 的两处任务物化点；`rearm` 清除失败态，retry 路由先 rearm 再唤醒，guide 翻转模式时同样清除。Web 收件箱行显示 Failed 徽标、failReason 提示与一键 Retry。

## Alternatives considered

**只修解码端归一化，生产端不动。** 不采用：错配被静默容忍会让两个 base64 helper 的语义边界永远模糊，未来任何严格 atob 消费方（包括第三方集成）都会重新踩中同一类故障；且生产端产出的 URL 与其声明语义（标准 base64）持续不一致。

**只修生产端，历史滞留消息不救。** 不采用：已滞留在收件箱里的条目依然无法投递，用户必须手动删除重建，"持久收件箱"契约下的存量数据被放弃。

**把 `InvalidUrlError` 加入 `PERMANENT_WAKE_ERROR_NAMES`。** 不采用：那只是把 5 次无效重试省掉，条目仍静默滞留、不可见、不可重试；永久错误名单的正确语义是"重试不可能推进"（如 worktree 缺失），而本故障在 payload 修复或解码兼容后完全可推进。

**task 物化失败后直接从收件箱删除。** 不采用：丢失用户内容；停靠保留完整 payload 供修复后 rearm 重投，代价只是一个状态字段。

## Consequences

失去：`SessionInboxItem` 契约增加两个可选字段（SDK 与 OpenAPI 已再生成）；解码端对 base64 payload 多一次字符串归一化（每次物化 O(n) 一次，n 为附件长度）。

得到：存量滞留消息自动恢复投递；同类确定性失败从"静默滞留 + 重试风暴"变为"可见失败 + 队列继续 + 一键重试"；解码端与 WHATWG forgiving-base64 语义对齐后，未来任何 URL-safe 变体的 data URL 也不再是故障源。
