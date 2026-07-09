import type { Component } from "solid-js"

export type ComposerSlotName =
  | "composer.above"
  | "composer.below"
  | "composer.toolbar.left"
  | "composer.toolbar.right"
  | "composer.add-menu"
  | "composer.start-option"

export interface ComposerSlotProps {
  slot: ComposerSlotName
  sessionId?: string
}

export interface ComposerSlotEntry {
  id: string
  slot: ComposerSlotName
  order?: number
  component?: Component<ComposerSlotProps>
  loader?: () => Promise<{ default: Component<ComposerSlotProps> }>
  pluginId: string
}

const entries: ComposerSlotEntry[] = []
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

export function registerComposerSlot(entry: ComposerSlotEntry): () => void {
  entries.push(entry)
  notify()
  return () => {
    const index = entries.indexOf(entry)
    if (index === -1) return
    entries.splice(index, 1)
    notify()
  }
}

export function getComposerSlotsByName(slot: ComposerSlotName): ComposerSlotEntry[] {
  return entries
    .filter((entry) => entry.slot === slot)
    .toSorted((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.id.localeCompare(b.id))
}

export function clearComposerSlots(pluginId?: string): void {
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

export function subscribeComposerSlots(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
