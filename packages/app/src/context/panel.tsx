import { createSignal, type JSX } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import type { IconName } from "@ericsanchezok/synergy-ui/icon"

export interface PanelDef {
  id: string
  label: string
  icon: IconName
}

export const PANELS: PanelDef[] = [
  { id: "engram", label: "Library", icon: "book-open" },
  { id: "agenda", label: "Agenda", icon: "clipboard-list" },
  { id: "holos", label: "Holos", icon: "users" },
  { id: "lucid", label: "Lucid", icon: "sparkles" },
]

export const { use: usePanel, provider: PanelProvider } = createSimpleContext({
  name: "Panel",
  gate: false,
  init: () => {
    const [active, setActive] = createSignal<string | null>(null)
    const slots = new Map<string, () => JSX.Element>()

    return {
      active,
      open: (id: string) => setActive(id),
      close: () => setActive(null),
      toggle: (id: string) => setActive((v) => (v === id ? null : id)),
      registerSlot: (id: string, render: () => JSX.Element) => {
        slots.set(id, render)
      },
      unregisterSlot: (id: string) => {
        slots.delete(id)
        setActive((v) => (v === id ? null : v))
      },
      slot: (id: string) => slots.get(id)?.(),
      hasSlot: (id: string) => slots.has(id),
    }
  },
})
