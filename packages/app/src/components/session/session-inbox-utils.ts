import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk/client"

function modeRank(mode: SessionInboxItem["mode"]): number {
  if (mode === "steer") return 0
  if (mode === "task") return 1
  if (mode === "context") return 2
  return 3
}

export function sortInboxItems(items: SessionInboxItem[]) {
  return items.slice().sort((a, b) => {
    const modeDiff = modeRank(a.mode) - modeRank(b.mode)
    if (modeDiff !== 0) return modeDiff
    const order = a.orderKey.localeCompare(b.orderKey)
    return order === 0 ? a.id.localeCompare(b.id) : order
  })
}

export type SessionInboxView =
  | { status: "loading"; items: SessionInboxItem[]; count: 0 }
  | { status: "empty"; items: SessionInboxItem[]; count: 0 }
  | { status: "ready"; items: SessionInboxItem[]; count: number }

export function deriveSessionInboxView(items: SessionInboxItem[] | undefined): SessionInboxView {
  if (items === undefined) return { status: "loading", items: [], count: 0 }

  const sorted = sortInboxItems(items)
  if (sorted.length === 0) return { status: "empty", items: sorted, count: 0 }

  return { status: "ready", items: sorted, count: sorted.length }
}

export function isInboxItemInteractive(item: SessionInboxItem) {
  return item.mode === "task"
}
