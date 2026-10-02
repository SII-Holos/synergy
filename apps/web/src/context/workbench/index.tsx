import { createWorkbenchClosePolicy } from "./close-policy"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { useLocale } from "@/context/locale"
import { createWorkspaceRevealPolicy } from "./reveal-policy"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
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
  sameWorkbenchResource,
  workbenchReplacementTab,
} from "./panel-model"

export interface OpenWorkbenchPanelOptions {
  activate?: boolean
  forceNew?: boolean
  reuseExisting?: boolean
  replaceEmpty?: boolean
  replaceCurrent?: boolean
  replaceTab?: string
  intent?: "user" | "restore" | "output"
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
    const dialog = useDialog()
    const reveal = createWorkspaceRevealPolicy(Date.now(), {
      read: (id) => layout.surface(`${params.dir}/${id}`, "side").reveal(),
      write: (id, value) => layout.surface(`${params.dir}/${id}`, "side").setReveal(value),
    })
    const interact = () => {
      if (params.id) {
        reveal.interact(params.id)
        return
      }
      const target = layout.surface(sessionKey(), "side")
      target.setReveal({ ...target.reveal(), interacted: true })
    }
    const { i18n } = useLocale()
    const closePolicy = createWorkbenchClosePolicy(
      (tab) =>
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
      (tab) => getWorkbenchPanel(tab.panelId)?.beforeCloseTab?.(tab),
    )
    const batchClosingSurfaces = new Set<string>()
    const openingDocuments = new Map<string, symbol>()

    const unsubscribe = subscribeWorkbenchPanels(() => setRegistryVersion((value) => value + 1))
    onCleanup(unsubscribe)

    function surface(surfaceName: WorkbenchPanelSurface) {
      const value = layout.surface(sessionKey(), surfaceName)
      return {
        ...value,
        open: () => {
          interact()
          value.open()
        },
        close: () => {
          interact()
          value.close()
        },
        toggle: () => {
          interact()
          value.toggle()
        },
      }
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
      const requestKey = JSON.stringify([boundSession, panelId])
      const request = Symbol()
      openingDocuments.set(requestKey, request)
      if ((options.intent ?? "user") === "user") interact()
      const requestedInit = options.init && entry.resolveTab ? await entry.resolveTab(options.init) : options.init
      if (options.init && entry.resolveTab && !requestedInit) return undefined
      const target = layout.surface(boundSession, entry.surface)
      if (
        options.replaceTab &&
        !target.tabs().some((tab) => tab.id === options.replaceTab && tab.panelId === "resource-home")
      )
        return undefined
      const tabs = target.tabs()
      const shouldReuse = options.reuseExisting || (!options.forceNew && entry.cardinality !== "multi")
      const requestedResource = requestedInit?.resourceId ?? entry.defaultResource?.resourceId
      const existing = shouldReuse
        ? tabs.find(
            (tab) =>
              tab.panelId === panelId &&
              (requestedResource === undefined || sameWorkbenchResource(tab, panelId, requestedInit)),
          )
        : undefined
      let init: WorkbenchPanelTabInit | undefined = existing
        ? { ...existing, ...requestedInit, id: existing.id }
        : (requestedInit ?? entry.defaultResource)
      if (!init && entry.createTab) {
        const created = await (options.intent === "restore" ? (entry.restoreTab ?? entry.createTab) : entry.createTab)(
          requestedInit,
        )
        if (!created) return undefined
        init = created
      }
      if (sessionKey() !== boundSession || openingDocuments.get(requestKey) !== request) return undefined
      if (options.intent === "restore" && !target.opened()) return undefined
      const replaceCurrent = options.replaceCurrent === true && !options.forceNew
      const replacement = workbenchReplacementTab({
        tabs: target.tabs(),
        panelId,
        init,
        active: target.active(),
        replaceCurrent,
        replaceEmpty: options.replaceEmpty,
        replaceTab: options.replaceTab,
      })
      if (replacement && replacement.resourceId !== undefined && !sameWorkbenchResource(replacement, panelId, init)) {
        if (!(await closePolicy.canClose(boundSession, replacement))) return undefined
        if (sessionKey() !== boundSession || openingDocuments.get(requestKey) !== request) return undefined
        const current = target.tabs().find((tab) => tab.id === replacement.id)
        if (!current || !sameWorkbenchResource(current, panelId, replacement)) return undefined
        init = { ...init, id: replacement.id, dirty: false }
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
        replaceCurrent,
        replaceTab: options.replaceTab,
        active: replacement?.id ?? target.active(),
      })

      target.setTabs(next.tabs)
      if (options.activate !== false) {
        target.setActive(next.active)
        target.open()
      } else if (!target.active()) target.setActive(next.active)
      return next.tabs.find((tab) => tab.id === next.active)
    }

    async function closeBoundTab(boundSession: string, surfaceName: WorkbenchPanelSurface, tabId: string) {
      const guardKey = JSON.stringify([boundSession, tabId])
      if (!closeGuard.begin(guardKey)) return false
      try {
        const target = layout.surface(boundSession, surfaceName)
        const current = target.tabs().find((item) => item.id === tabId)
        if (!current) return true
        const tab = { ...current }
        if (!(await closePolicy.canClose(boundSession, tab))) return false
        const stillCurrent = () =>
          target.tabs().some((item) => item.id === tabId && sameWorkbenchResource(item, tab.panelId, tab))
        if (!stillCurrent()) return false
        if ((await getWorkbenchPanel(tab.panelId)?.onCloseTab?.(tab)) === false) return false
        if (!stillCurrent()) return false
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
      interact()
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

    async function closeOtherTabsOnSurface(
      surfaceName: WorkbenchPanelSurface,
      keepTabId: string,
      side: "others" | "right" = "others",
    ) {
      const boundSession = sessionKey()
      const batchKey = JSON.stringify([boundSession, surfaceName])
      if (batchClosingSurfaces.has(batchKey)) return
      const target = layout.surface(boundSession, surfaceName)
      const keep = target.tabs().find((item) => item.id === keepTabId)
      if (!keep) return

      batchClosingSurfaces.add(batchKey)
      try {
        const tabs = target.tabs()
        const keepIndex = tabs.findIndex((tab) => tab.id === keepTabId)
        const closingIds = tabs
          .filter((tab, index) => (side === "right" ? index > keepIndex : tab.id !== keepTabId))
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
      sessionKey,
      surface,
      panels(surfaceName: WorkbenchPanelSurface) {
        return surfaceName === "side" ? sideEntries() : bottomEntries()
      },
      getPanel: visibleEntry,
      panelForTab,
      panelTitle,
      openPanel,
      interact,
      async revealOutput(input: {
        sessionID: string
        key: string
        completedAt: number
        panelId: string
        init: WorkbenchPanelTabInit
      }) {
        if (!visibleEntry(input.panelId)) return
        const focus = document.activeElement
        const busy = Boolean(
          dialog.active || (focus instanceof Element && focus.closest('[data-ui-part="resource-panel"]')),
        )
        const available = window.innerWidth - layout.sidebar.occupiedWidth()
        const action = reveal.request({
          ...input,
          currentSessionID: params.id,
          busy,
          overlay: available < 710 || surface("side").fullscreen(),
        })
        if (action === "ignore") return
        if (action === "notify") {
          const key = sessionKey()
          showToast({
            type: "info",
            title: i18n._({ id: "workspace.output.ready", message: "New resource ready" }),
            description: input.init.title,
            actions: [
              {
                label: i18n._({ id: "workspace.output.view", message: "View" }),
                onClick: () => {
                  if (sessionKey() === key) void openPanel(input.panelId, { init: input.init, replaceCurrent: true })
                },
              },
            ],
          })
          return
        }
        await openPanel(input.panelId, { intent: "output", init: input.init, replaceCurrent: true })
        if (focus instanceof HTMLElement && focus.isConnected && document.activeElement !== focus) focus.focus()
      },
      activateTab(surfaceName: WorkbenchPanelSurface, tabId: string) {
        interact()
        const target = surface(surfaceName)
        if (!target.tabs().some((tab) => tab.id === tabId)) return
        target.setActive(tabId)
        target.open()
      },
      beforeClose(tabId: string, handler: () => boolean | Promise<boolean>) {
        return closePolicy.register(sessionKey(), tabId, handler)
      },
      async canLeave(tabId: string) {
        const key = sessionKey()
        const tab = [...surface("side").tabs(), ...surface("bottom").tabs()].find((tab) => tab.id === tabId)
        return !tab || (await closePolicy.canClose(key, tab))
      },
      closeTab,
      closeOtherTabs,
      closeOtherTabsOnSurface,
      updateTab,
      moveTab,
    }
  },
})
