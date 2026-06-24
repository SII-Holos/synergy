import { createSignal, type JSX } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import type { IconName } from "@ericsanchezok/synergy-ui/icon"
import { listGlobalPanels } from "@/plugin"

export interface PanelDef {
  id: string
  label: string
  icon: IconName
}

const BUILTIN_PANELS: PanelDef[] = [
  { id: "agenda", label: "Agenda", icon: "clock" },
  { id: "engram", label: "Library", icon: "book-open" },
  { id: "lucid", label: "Lucid", icon: "sparkles" },
  { id: "diagnostics", label: "Diagnostics", icon: "stethoscope" },
]

export const PANELS: PanelDef[] = [
  ...BUILTIN_PANELS,
  ...listGlobalPanels().map((p) => ({
    id: p.id,
    label: p.label,
    icon: p.icon as IconName,
  })),
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
