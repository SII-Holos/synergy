import type { Component } from "solid-js"
import type { MessageSlotProps } from "@ericsanchezok/synergy-ui/message-slots"
import { SlotRegistry, type SlotEntryBase } from "../slot-registry"

export interface MessageSlotEntry extends SlotEntryBase {
  slot: "message.before" | "message.after" | "message.actions"
  roles?: Array<"user" | "assistant">
  loader?: () => Promise<{ default: Component<MessageSlotProps> }>
}

/** Message slot entries, grouped by slot name via the shared slot registry. */
const registry = new SlotRegistry<MessageSlotEntry>()

export function registerMessageSlot(entry: MessageSlotEntry): () => void {
  return registry.register(entry)
}

export function getMessageSlots(slot: string): MessageSlotEntry[] {
  return registry.list(slot)
}

export function subscribeMessageSlots(listener: () => void): () => void {
  return registry.subscribe(listener)
}
