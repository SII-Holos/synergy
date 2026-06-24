import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk/client"

export function sortInboxItems(items: SessionInboxItem[]) {
  const deliveryRank: Record<SessionInboxItem["deliveryTarget"], number> = {
    next_model_call: 0,
    after_turn: 1,
  }
  return items.slice().sort((a, b) => {
    const delivery = deliveryRank[a.deliveryTarget] - deliveryRank[b.deliveryTarget]
    if (delivery !== 0) return delivery
    const order = a.orderKey.localeCompare(b.orderKey)
    return order === 0 ? a.id.localeCompare(b.id) : order
  })
}

export function isInboxItemInteractive(item: SessionInboxItem) {
  return item.kind === "queued_user"
}
