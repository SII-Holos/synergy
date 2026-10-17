export function buildBossDeliveryHint(delivery: { replyToMessageId?: string; chatId?: string } | undefined): string {
  const lines = [
    "<boss-delivery>",
    "This turn is not delivered to the channel automatically. A receipt must be explicitly delivered to its recorded destination.",
  ]
  if (delivery?.chatId) {
    lines.push(
      `Receipt target chat: ${delivery.chatId}${delivery.replyToMessageId ? `; reply to message: ${delivery.replyToMessageId}` : ""}`,
    )
  } else if (delivery?.replyToMessageId) {
    lines.push(`Receipt target message: ${delivery.replyToMessageId}`)
  }
  lines.push("</boss-delivery>")
  return lines.join("\n")
}
