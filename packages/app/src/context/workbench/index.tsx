import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useLayout } from "../layout"
import {
  getWorkbenchPanel,
  listWorkbenchPanels,
  subscribeWorkbenchPanels,
  type WorkbenchPanelEntry,
  type WorkbenchPanelSurface,
  type WorkbenchPanelTab,
  type WorkbenchPanelTabInit,
} from "@/plugin/registries/workbench-panel-registry"
import {
  closeWorkbenchPanelTab,
  isWorkbenchPanelAvailable,
  moveWorkbenchPanelTab,
  openWorkbenchPanelTab,
  updateWorkbenchPanelTab,
} from "./panel-model"

export interface OpenWorkbenchPanelOptions {
  forceNew?: boolean
  reuseExisting?: boolean
  replaceEmpty?: boolean
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
        return listWorkbenchPanels(surfaceName).filter((entry) => isWorkbenchPanelAvailable(entry, hasSession()))
      })

    const sideEntries = entries("side")
    const bottomEntries = entries("bottom")
    let previousSessionKey = sessionKey()
    let previousSessionID = params.id

    createEffect(() => {
      const next = sessionKey()
      const nextSessionID = params.id
      if (previousSessionKey !== next && !previousSessionID && nextSessionID) {
        layout.transferWorkbenchState(previousSessionKey, next)
      }
      previousSessionKey = next
      previousSessionID = nextSessionID
    })

    function createTabId(panelId: string) {
      nextTabIndex += 1
      return `${panelId}:${Date.now().toString(36)}:${nextTabIndex.toString(36)}`
    }

    function visibleEntry(panelId: string): WorkbenchPanelEntry | undefined {
      registryVersion()
      const entry = getWorkbenchPanel(panelId)
      if (!entry) return undefined
      if (!isWorkbenchPanelAvailable(entry, hasSession())) return undefined
      return entry
    }

    async function openPanel(panelId: string, options: OpenWorkbenchPanelOptions = {}) {
      const entry = visibleEntry(panelId)
      if (!entry) return undefined

      const target = surface(entry.surface)
      const tabs = target.tabs()
      const shouldReuse = options.reuseExisting || (!options.forceNew && entry.cardinality !== "multi")
      const requestedResource = options.init?.resourceId ?? entry.defaultResource?.resourceId
      const existing = shouldReuse
        ? tabs.find(
            (tab) =>
              tab.panelId === panelId && (requestedResource === undefined || tab.resourceId === requestedResource),
          )
        : undefined
      let init: WorkbenchPanelTabInit | undefined = existing
        ? { ...existing, ...options.init, id: existing.id }
        : (options.init ?? entry.defaultResource)
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
        replaceEmpty: options.replaceEmpty,
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

    function updateTab(tabId: string, patch: Omit<WorkbenchPanelTabInit, "id">) {
      for (const surfaceName of ["side", "bottom"] as const) {
        const target = surface(surfaceName)
        const next = updateWorkbenchPanelTab(target.tabs(), tabId, patch)
        if (next === target.tabs()) continue
        target.setTabs(next)
        return
      }
    }

    function moveTab(surfaceName: WorkbenchPanelSurface, tabId: string, index: number) {
      const target = surface(surfaceName)
      const next = moveWorkbenchPanelTab(target.tabs(), tabId, index)
      if (next === target.tabs()) return
      target.setTabs(next)
    }

    function panelTitle(tab: WorkbenchPanelTab) {
      registryVersion()
      const entry = getWorkbenchPanel(tab.panelId)
      const siblings = (["side", "bottom"] as const)
        .map((surfaceName) => surface(surfaceName).tabs())
        .find((tabs) => tabs.some((candidate) => candidate.id === tab.id))
      return entry?.title?.(tab, siblings ?? []) ?? tab.title ?? entry?.label ?? "Panel"
    }

    function panelForTab(tab: WorkbenchPanelTab | undefined) {
      registryVersion()
      if (!tab) return undefined
      return getWorkbenchPanel(tab.panelId)
    }

    const openFromPlugin = (event: Event) => {
      const detail = (
        event as CustomEvent<{ panelId?: string; resource?: { id: string; title?: string; state?: unknown } }>
      ).detail
      if (!detail?.panelId) return
      void openPanel(detail.panelId, {
        init: {
          resourceId: detail.resource?.id,
          title: detail.resource?.title,
          state: detail.resource?.state,
          source: "plugin",
        },
      })
    }
    window.addEventListener("synergy:plugin-open-workbench", openFromPlugin)
    onCleanup(() => window.removeEventListener("synergy:plugin-open-workbench", openFromPlugin))

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
      updateTab,
      moveTab,
    }
  },
})
