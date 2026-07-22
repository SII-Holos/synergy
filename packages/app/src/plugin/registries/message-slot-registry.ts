import type { Component } from "solid-js"
import type { MessageSlotProps } from "@ericsanchezok/synergy-ui/message-slots"

export interface MessageSlotEntry {
  id: string
  slot: "message.before" | "message.after" | "message.actions"
  roles?: Array<"user" | "assistant">
  order: number
  pluginId: string
  loader: () => Promise<{ default: Component<MessageSlotProps> }>
}

const entries: MessageSlotEntry[] = []
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

export function registerMessageSlot(entry: MessageSlotEntry) {
  if (entries.some((candidate) => candidate.id === entry.id)) throw new Error(`Duplicate message slot ${entry.id}`)
  entries.push(entry)
  notify()
  return () => {
    const index = entries.indexOf(entry)
    if (index < 0) return
    entries.splice(index, 1)
    notify()
  }
}

export function getMessageSlots(slot: string) {
  return entries
    .filter((entry) => entry.slot === slot)
    .toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

export function subscribeMessageSlots(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
