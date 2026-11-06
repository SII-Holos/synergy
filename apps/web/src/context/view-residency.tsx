import { recordFrontendWork } from "@/components/performance/browser-metrics"
import { createContext, onCleanup, useContext, type Accessor, type ParentProps } from "solid-js"

export function pauseHiddenScroll(element: HTMLElement, active: Accessor<boolean>) {
  // Hidden boxes report scrollTop as zero; late native receipts must not reset a retained virtual window.
  const capture = (event: Event) => {
    if (!active()) event.stopPropagation()
  }
  element.addEventListener("scroll", capture, true)
  onCleanup(() => element.removeEventListener("scroll", capture, true))
}

export function createResidencyBudget(limit: number, report?: (size: number) => void) {
  const entries = new Map<object, { active: boolean; evict(): void }>()
  const trim = () => {
    for (const [key, entry] of entries) {
      if (entries.size <= limit) break
      if (entry.active) continue
      entries.delete(key)
      entry.evict()
    }
  }
  return {
    retain(key: object, evict: () => void) {
      entries.set(key, { active: true, evict })
      trim()
      report?.(entries.size)
      return () => {
        entries.delete(key)
        report?.(entries.size)
      }
    },
    active(key: object, active: boolean) {
      const entry = entries.get(key)
      if (!entry) return
      entry.active = active
      if (active) {
        entries.delete(key)
        entries.set(key, entry)
      }
      trim()
    },
    evictInactive() {
      for (const [key, entry] of entries) {
        if (entry.active) continue
        entries.delete(key)
        entry.evict()
      }
    },
    size: () => entries.size,
  }
}

const ResidencyContext = createContext<{
  sessions: ReturnType<typeof createResidencyBudget>
  panels: ReturnType<typeof createResidencyBudget>
}>()

export function ViewResidencyProvider(props: ParentProps) {
  const value = {
    sessions: createResidencyBudget(6, (size) =>
      recordFrontendWork("frontend.resident.sessions", size, "count", "last"),
    ),
    panels: createResidencyBudget(8, (size) => recordFrontendWork("frontend.resident.panels", size, "count", "last")),
  }
  return <ResidencyContext.Provider value={value}>{props.children}</ResidencyContext.Provider>
}

export function useViewResidency() {
  return useContext(ResidencyContext)
}

export { ViewActivityProvider, useViewActivity } from "@ericsanchezok/synergy-ui/context/view-activity"
