import type { Component } from "solid-js"

export type ChatSlot = "before-tools" | "after-tools" | "before-reasoning" | "after-reasoning"

export interface ChatComponentEntry {
  id: string
  slot: ChatSlot
  component: Component
  loader?: () => Promise<{ default: Component }> // lazy-load for Tier 2
  pluginId: string
}

const entries: ChatComponentEntry[] = []

export function registerChatComponent(entry: ChatComponentEntry): () => void {
  entries.push(entry)
  return () => {
    const index = entries.indexOf(entry)
    if (index !== -1) entries.splice(index, 1)
  }
}

export function getChatComponentsBySlot(slot: string): ChatComponentEntry[] {
  return entries.filter((e) => e.slot === slot)
}
