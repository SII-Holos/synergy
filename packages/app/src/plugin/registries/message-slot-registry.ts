import type { Component } from "solid-js"

export type MessageSlotName = "before-reasoning" | "after-reasoning" | "before-tools" | "after-tools"

export interface MessageSlotProps {
  slot: MessageSlotName
  sessionId?: string
  messageId?: string
}

export interface MessageSlotEntry {
  id: string
  slot: MessageSlotName
  component?: Component<MessageSlotProps>
  loader?: () => Promise<{ default: Component<MessageSlotProps> }>
  pluginId: string
}

const entries: MessageSlotEntry[] = []
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

export function registerMessageSlot(entry: MessageSlotEntry): () => void {
  entries.push(entry)
  notify()
  return () => {
    const index = entries.indexOf(entry)
    if (index !== -1) {
      entries.splice(index, 1)
      notify()
    }
  }
}

export function getMessageSlotsByName(slot: MessageSlotName): MessageSlotEntry[] {
  return entries.filter((entry) => entry.slot === slot)
}

export function clearMessageSlots(pluginId?: string): void {
  if (!pluginId) {
    if (entries.length === 0) return
    entries.length = 0
    notify()
    return
  }

  let changed = false
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.pluginId !== pluginId) continue
    entries.splice(index, 1)
    changed = true
  }
  if (changed) notify()
}

export function subscribeMessageSlots(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
