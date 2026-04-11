import { createSignal, type JSX } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"

export const { use: usePanel, provider: PanelProvider } = createSimpleContext({
  name: "Panel",
  gate: false,
  init: () => {
    const [active, setActive] = createSignal<string | null>(null)
    const [scopesDrilldown, setScopesDrilldown] = createSignal<string | null>(null)
    const slots = new Map<string, () => JSX.Element>()

    return {
      active,
      open: (id: string) => setActive(id),
      close: () => {
        setActive(null)
        setScopesDrilldown(null)
      },
      toggle: (id: string) => {
        setActive((v) => {
          if (v === id) {
            setScopesDrilldown(null)
            return null
          }
          return id
        })
      },
      scopes: {
        drilldown: scopesDrilldown,
        open(worktree: string) {
          setScopesDrilldown(worktree)
          setActive("scopes")
        },
        back() {
          setScopesDrilldown(null)
        },
      },
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
