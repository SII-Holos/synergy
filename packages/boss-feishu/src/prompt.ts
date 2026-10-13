export function buildBossDeliveryHint(delivery: { replyToMessageId?: string; chatId?: string } | undefined): string {
  const lines = [
    "<boss-delivery>",
    "本轮回复不会自动投递回渠道 — 用户看不到你的任何输出,除非你显式调用 channel_push 回传。",
    "需要向用户回执时,必须调用 channel_push(带 text,以及匹配的回执目标)。",
  ]
  if (delivery?.chatId) {
    lines.push(
      `当前回执目标 chat: ${delivery.chatId}${delivery.replyToMessageId ? `; 回复消息: ${delivery.replyToMessageId}` : ""}`,
    )
  } else if (delivery?.replyToMessageId) {
    lines.push(`当前回执目标消息: ${delivery.replyToMessageId}`)
  }
  lines.push("</boss-delivery>")
  return lines.join("\n")
}
