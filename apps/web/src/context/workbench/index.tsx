import { createWorkbenchClosePolicy } from "./close-policy"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { useLocale } from "@/context/locale"
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
  createTabCloseGuard,
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
    const closeGuard = createTabCloseGuard()
    const confirm = useConfirm()
    const { i18n } = useLocale()
    const closePolicy = createWorkbenchClosePolicy((tab) =>
      confirm.ask({
        title: i18n._({ id: "workbench.discard.title", message: "Discard unsaved changes?" }),
        description: i18n._({
          id: "workbench.discard.description",
          message: "Changes in {title} have not been saved.",
          values: { title: panelTitle(tab) },
        }),
        confirmLabel: i18n._({ id: "workbench.discard.action", message: "Discard changes" }),
        tone: "danger",
      }),
    )
    const batchClosingSurfaces = new Set<string>()

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

      const boundSession = sessionKey()
      const target = layout.surface(boundSession, entry.surface)
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

      if (entry.cardinality === "exclusive") {
        for (const tab of target.tabs()) {
          if (tab.id === existing?.id) continue
          if (!(await closeBoundTab(boundSession, entry.surface, tab.id))) return undefined
        }
        if (target.tabs().some((tab) => tab.id !== existing?.id)) return undefined
      }
      const next = openWorkbenchPanelTab({
        panelId,
        cardinality: entry.cardinality,
        tabs: target.tabs(),
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

    async function closeBoundTab(boundSession: string, surfaceName: WorkbenchPanelSurface, tabId: string) {
      const guardKey = JSON.stringify([boundSession, tabId])
      if (!closeGuard.begin(guardKey)) return false
      try {
        const target = layout.surface(boundSession, surfaceName)
        const tab = target.tabs().find((item) => item.id === tabId)
        if (!tab) return true
        if (!(await closePolicy.canClose(boundSession, tab))) return false
        if ((await getWorkbenchPanel(tab.panelId)?.onCloseTab?.(tab)) === false) return false
        const next = closeWorkbenchPanelTab(target.tabs(), target.active(), tabId)
        target.setTabs(next.tabs)
        target.setActive(next.active)
        if (!next.tabs.length) target.close()
        return true
      } finally {
        closeGuard.end(guardKey)
      }
    }

    async function closeTab(tabId: string) {
      const boundSession = sessionKey()
      for (const surfaceName of ["side", "bottom"] as const) {
        if (
          !layout
            .surface(boundSession, surfaceName)
            .tabs()
            .some((tab) => tab.id === tabId)
        )
          continue
        return closeBoundTab(boundSession, surfaceName, tabId)
      }
      return true
    }

    async function closeOtherTabsOnSurface(surfaceName: WorkbenchPanelSurface, keepTabId: string) {
      const boundSession = sessionKey()
      const batchKey = JSON.stringify([boundSession, surfaceName])
      if (batchClosingSurfaces.has(batchKey)) return
      const target = layout.surface(boundSession, surfaceName)
      const keep = target.tabs().find((item) => item.id === keepTabId)
      if (!keep) return

      batchClosingSurfaces.add(batchKey)
      try {
        const closingIds = target
          .tabs()
          .filter((tab) => tab.id !== keepTabId)
          .map((tab) => tab.id)
        for (const id of closingIds) {
          try {
            await closeBoundTab(boundSession, surfaceName, id)
          } catch (error) {
            console.error("Workbench resource could not close", error)
          }
        }
        if (target.tabs().some((tab) => tab.id === keepTabId)) target.setActive(keepTabId)
      } finally {
        batchClosingSurfaces.delete(batchKey)
      }
    }

    async function closeOtherTabs(keepTabId: string) {
      for (const surfaceName of ["side", "bottom"] as const) {
        if (
          !surface(surfaceName)
            .tabs()
            .some((item) => item.id === keepTabId)
        )
          continue
        await closeOtherTabsOnSurface(surfaceName, keepTabId)
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

    return {
      surface,
      panels(surfaceName: WorkbenchPanelSurface) {
        return surfaceName === "side" ? sideEntries() : bottomEntries()
      },
      getPanel: visibleEntry,
      panelForTab,
      panelTitle,
      openPanel,
      beforeClose(tabId: string, handler: () => boolean | Promise<boolean>) {
        return closePolicy.register(sessionKey(), tabId, handler)
      },
      closeTab,
      closeOtherTabs,
      closeOtherTabsOnSurface,
      updateTab,
      moveTab,
    }
  },
})
