import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useLayout } from "./layout"
import {
  getWorkbenchPanel,
  listWorkbenchPanels,
  subscribeWorkbenchPanels,
  type WorkbenchPanelEntry,
  type WorkbenchPanelSurface,
  type WorkbenchPanelTab,
  type WorkbenchPanelTabInit,
} from "@/plugin/registries/workbench-panel-registry"
import { closeWorkbenchPanelTab, openWorkbenchPanelTab } from "./workbench-panels-model"

export interface OpenWorkbenchPanelOptions {
  forceNew?: boolean
  reuseExisting?: boolean
  init?: WorkbenchPanelTabInit
}

export const { use: useWorkbenchPanels, provider: WorkbenchPanelsProvider } = createSimpleContext({
  name: "WorkbenchPanels",
  gate: false,
  init: () => {
    const layout = useLayout()
    const params = useParams()
    const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
    const hasSession = createMemo(() => !!params.id)
    const [registryVersion, setRegistryVersion] = createSignal(0)
    let nextTabIndex = 0

    const unsubscribe = subscribeWorkbenchPanels(() => setRegistryVersion((value) => value + 1))
    onCleanup(unsubscribe)

    function surface(surfaceName: WorkbenchPanelSurface) {
      return layout.surface(sessionKey(), surfaceName)
    }

    const entries = (surfaceName: WorkbenchPanelSurface) =>
      createMemo(() => {
        registryVersion()
        return listWorkbenchPanels(surfaceName).filter((entry) => !entry.requiresSession || hasSession())
      })

    const sideEntries = entries("side")
    const bottomEntries = entries("bottom")

    function createTabId(panelId: string) {
      nextTabIndex += 1
      return `${panelId}:${Date.now().toString(36)}:${nextTabIndex.toString(36)}`
    }

    function visibleEntry(panelId: string): WorkbenchPanelEntry | undefined {
      registryVersion()
      const entry = getWorkbenchPanel(panelId)
      if (!entry) return undefined
      if (entry.requiresSession && !hasSession()) return undefined
      return entry
    }

    async function openPanel(panelId: string, options: OpenWorkbenchPanelOptions = {}) {
      const entry = visibleEntry(panelId)
      if (!entry) return undefined

      const target = surface(entry.surface)
      const tabs = target.tabs()
      const shouldReuse = options.reuseExisting || (!options.forceNew && entry.cardinality !== "multi")
      const existing = shouldReuse ? tabs.find((tab) => tab.panelId === panelId) : undefined
      let init: WorkbenchPanelTabInit | undefined = existing
        ? { ...existing, ...options.init, id: existing.id }
        : options.init
      if (!init && entry.createTab) {
        const created = await entry.createTab()
        if (!created) return undefined
        init = created
      }

      const next = openWorkbenchPanelTab({
        panelId,
        cardinality: entry.cardinality,
        tabs,
        init,
        createId: () => createTabId(panelId),
        reuseExisting: options.reuseExisting && !options.forceNew,
      })

      target.setTabs(next.tabs)
      target.setActive(next.active)
      target.open()
      return next.tabs.find((tab) => tab.id === next.active)
    }

    async function closeTab(tabId: string) {
      for (const surfaceName of ["side", "bottom"] as const) {
        const target = surface(surfaceName)
        const tab = target.tabs().find((item) => item.id === tabId)
        if (!tab) continue

        const entry = getWorkbenchPanel(tab.panelId)
        await entry?.onCloseTab?.(tab)

        const next = closeWorkbenchPanelTab(target.tabs(), target.active(), tabId)
        target.setTabs(next.tabs)
        target.setActive(next.active)
        if (next.tabs.length === 0) target.close()
        return
      }
    }

    function panelTitle(tab: WorkbenchPanelTab) {
      const entry = getWorkbenchPanel(tab.panelId)
      return entry?.title?.(tab) ?? tab.title ?? entry?.label ?? "Panel"
    }

    function panelForTab(tab: WorkbenchPanelTab | undefined) {
      if (!tab) return undefined
      return getWorkbenchPanel(tab.panelId)
    }

    createEffect(() => {
      for (const surfaceName of ["side", "bottom"] as const) {
        const target = surface(surfaceName)
        const visible = new Set((surfaceName === "side" ? sideEntries() : bottomEntries()).map((entry) => entry.id))
        const currentTabs = target.tabs()
        const nextTabs = currentTabs.filter((tab) => visible.has(tab.panelId))
        if (nextTabs.length === currentTabs.length) continue

        target.setTabs(nextTabs)
        if (!nextTabs.some((tab) => tab.id === target.active())) {
          target.setActive(nextTabs[0]?.id)
        }
        if (nextTabs.length === 0) target.close()
      }
    })

    return {
      surface,
      panels(surfaceName: WorkbenchPanelSurface) {
        return surfaceName === "side" ? sideEntries() : bottomEntries()
      },
      getPanel: visibleEntry,
      panelForTab,
      panelTitle,
      openPanel,
      closeTab,
    }
  },
})
