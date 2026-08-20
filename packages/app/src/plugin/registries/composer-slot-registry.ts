import type { Component } from "solid-js"
import { SlotRegistry, type SlotEntryBase } from "../slot-registry"

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

export interface ComposerSlotEntry extends SlotEntryBase {
  slot: ComposerSlotName
  component?: Component<ComposerSlotProps>
  loader?: () => Promise<{ default: Component<ComposerSlotProps> }>
}

/** Composer slot entries, grouped by slot name via the shared slot registry. */
const registry = new SlotRegistry<ComposerSlotEntry>()

export function registerComposerSlot(entry: ComposerSlotEntry): () => void {
  return registry.register(entry)
}

export function getComposerSlotsByName(slot: ComposerSlotName): ComposerSlotEntry[] {
  return registry.list(slot)
}

export function clearComposerSlots(pluginId?: string): void {
  registry.clear(pluginId)
}

export function subscribeComposerSlots(listener: () => void): () => void {
  return registry.subscribe(listener)
}
