import { createWorkbenchClosePolicy } from "./close-policy"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { useLocale } from "@/context/locale"
import { createWorkspaceRevealPolicy } from "./reveal-policy"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import type { JSX } from "solid-js"
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
  type WorkbenchPanelOpening,
  type WorkbenchPanelOpenContext,
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
    const [openings, setOpenings] = createStore<
      Record<
        string,
        {
          session: string
          surface: WorkbenchPanelSurface
          tab: WorkbenchPanelTab
          index: number
          phase: "preparing" | "error"
          error?: unknown
        }
      >
    >({})
    const [openingActive, setOpeningActive] = createStore<Record<string, string | undefined>>({})
    const openingTasks = new Map<
      string,
      {
        context: WorkbenchPanelOpenContext
        cancelled: boolean
        abandoned: boolean
        handlers: Set<() => void | Promise<void>>
        pending?: Promise<WorkbenchPanelTab | undefined>
        result?: WorkbenchPanelTab
        run(): Promise<WorkbenchPanelTab | undefined>
      }
    >()
    const [disposed, setDisposed] = createSignal(false)
    onCleanup(() => {
      setDisposed(true)
      for (const task of openingTasks.values()) task.abandoned = true
      openingTasks.clear()
    })

    function removeOpening(id: string) {
      setOpenings(
        produce((state) => {
          delete state[id]
        }),
      )
    }

    function projectedTabs(boundSession: string, surfaceName: WorkbenchPanelSurface) {
      const tabs = layout
        .surface(boundSession, surfaceName)
        .tabs()
        .filter((tab) => !openings[tab.id])
      for (const opening of Object.values(openings)
        .filter((opening) => opening.session === boundSession && opening.surface === surfaceName)
        .sort((a, b) => a.index - b.index)) {
        tabs.splice(Math.min(opening.index, tabs.length), 0, opening.tab)
      }
      return tabs
    }

    function prepareDefault(surfaceName: WorkbenchPanelSurface) {
      if (surfaceName !== "side" || surface(surfaceName).activeTab() || !visibleEntry("resource-home")) return
      if (visibleEntry("browser")?.openingComponent) void openPanel("browser", { intent: "restore" })
    }

    const unsubscribe = subscribeWorkbenchPanels(() => setRegistryVersion((value) => value + 1))
    onCleanup(unsubscribe)

    function surface(surfaceName: WorkbenchPanelSurface) {
      const boundSession = sessionKey()
      const value = layout.surface(boundSession, surfaceName)
      const key = JSON.stringify([boundSession, surfaceName])
      const tabs = () => projectedTabs(boundSession, surfaceName)
      const active = () => openingActive[key] ?? value.active()
      return {
        ...value,
        savedTabs: value.tabs,
        tabs,
        active,
        activeTab: () => tabs().find((tab) => tab.id === active()),
        setTabs: (next: WorkbenchPanelTab[]) =>
          batch(() => {
            next.forEach((tab, index) => {
              if (openings[tab.id]) setOpenings(tab.id, "index", index)
            })
            value.setTabs(next.filter((tab) => !openings[tab.id]))
          }),
        setActive: (id: string | undefined) => {
          setOpeningActive(key, id && openings[id] ? id : undefined)
          if (!id || !openings[id]) value.setActive(id)
        },
        hasOpening: () =>
          Object.values(openings).some(
            (opening) => opening.session === boundSession && opening.surface === surfaceName,
          ),
        open: () => {
          interact()
          batch(() => {
            prepareDefault(surfaceName)
            value.open()
          })
        },
        close: () => {
          interact()
          value.close()
        },
        toggle: () => {
          interact()
          batch(() => {
            if (!value.opened()) prepareDefault(surfaceName)
            value.toggle()
          })
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
      if (previousSessionKey !== next) {
        for (const [id, task] of openingTasks) {
          if (openings[id]?.session !== previousSessionKey) continue
          task.abandoned = true
          removeOpening(id)
        }
        for (const name of ["side", "bottom"] as const)
          setOpeningActive(JSON.stringify([previousSessionKey, name]), undefined)
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
      if (
        !entry.openingComponent ||
        options.activate === false ||
        (options.init?.resourceId &&
          layout
            .surface(boundSession, entry.surface)
            .tabs()
            .some((tab) => sameWorkbenchResource(tab, panelId, options.init)))
      )
        return resolvePanel(entry, panelId, options, boundSession)
      const previous = Object.values(openings).find(
        (opening) =>
          opening.session === boundSession &&
          opening.tab.panelId === panelId &&
          !options.forceNew &&
          (options.intent === "restore" || options.reuseExisting),
      )
      if (previous) return openingTasks.get(previous.tab.id)?.run()
      const id = options.replaceTab ?? createTabId(panelId)
      const key = JSON.stringify([boundSession, entry.surface])
      const handlers = new Set<() => void | Promise<void>>()
      const context: WorkbenchPanelOpenContext = {
        requestId: `workbench_open_${generateUUID()}`,
        onCancel(handler) {
          if (task.cancelled) return Promise.resolve().then(handler).catch(reportOpeningCleanup)
          else handlers.add(handler)
        },
      }
      const task = {
        context,
        handlers,
        cancelled: false,
        abandoned: false,
        pending: undefined as Promise<WorkbenchPanelTab | undefined> | undefined,
        result: undefined as WorkbenchPanelTab | undefined,
        run() {
          if (task.pending) return task.pending
          if (task.result) return Promise.resolve(task.result)
          if (task.cancelled || task.abandoned || disposed()) return Promise.resolve(undefined)
          setOpenings(id, { phase: "preparing", error: undefined })
          const requestKey = JSON.stringify([boundSession, panelId, id])
          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              openingDocuments.delete(requestKey)
              reject(
                new Error(
                  i18n._({
                    id: "browser.prepare.timeout",
                    message: "Browser preparation timed out. Retry to check the same page.",
                  }),
                ),
              )
            }, 15_000)
          })
          task.pending = Promise.race([
            resolvePanel(entry, panelId, options, boundSession, { id, context, task }),
            timeout,
          ])
            .then((tab) => {
              if (!tab && !task.cancelled && !task.abandoned)
                throw new Error(i18n._({ id: "browser.prepare.failed", message: "Browser preparation failed. Retry." }))
              task.result = tab
              return tab
            })
            .catch((error: unknown) => {
              if (!task.cancelled && !task.abandoned && !disposed()) setOpenings(id, { phase: "error", error })
              return undefined
            })
            .finally(() => {
              clearTimeout(timer)
              openingDocuments.delete(requestKey)
              task.pending = undefined
              if (task.result || task.cancelled || task.abandoned) openingTasks.delete(id)
            })
          return task.pending
        },
      }
      openingTasks.set(id, task)
      batch(() => {
        setOpenings(id, {
          session: boundSession,
          surface: entry.surface,
          tab: { id, panelId, title: entry.label },
          index: options.replaceTab
            ? layout
                .surface(boundSession, entry.surface)
                .tabs()
                .findIndex((tab) => tab.id === options.replaceTab)
            : projectedTabs(boundSession, entry.surface).length,
          phase: "preparing",
        })
        setOpeningActive(key, id)
        if (options.intent !== "restore") layout.surface(boundSession, entry.surface).open()
      })
      return task.run()
    }

    function reportOpeningCleanup(error: unknown) {
      showToast({
        type: "error",
        title: i18n._({ id: "browser.prepare.cleanup", message: "Browser page could not close" }),
        description: error instanceof Error ? error.message : undefined,
      })
    }

    async function resolvePanel(
      entry: WorkbenchPanelEntry,
      panelId: string,
      options: OpenWorkbenchPanelOptions,
      boundSession: string,
      opening?: { id: string; context: WorkbenchPanelOpenContext; task: { cancelled: boolean; abandoned: boolean } },
    ) {
      const requestKey = JSON.stringify(opening ? [boundSession, panelId, opening.id] : [boundSession, panelId])
      const request = Symbol()
      openingDocuments.set(requestKey, request)
      if ((options.intent ?? "user") === "user") interact()
      const requestedInit =
        options.init && entry.resolveTab ? await entry.resolveTab(options.init, opening?.context) : options.init
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
        const created = await (options.intent === "restore" && entry.restoreTab
          ? entry.restoreTab(opening?.context)
          : entry.createTab(requestedInit, opening?.context))
        if (!created) return undefined
        init = created
      }
      if (
        disposed() ||
        opening?.task.cancelled ||
        opening?.task.abandoned ||
        sessionKey() !== boundSession ||
        openingDocuments.get(requestKey) !== request
      )
        return undefined
      if (!opening && options.intent === "restore" && !target.opened()) return undefined
      if (opening) init = { ...init, id: opening.id }
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

      let committed = next.tabs.find((tab) => tab.id === next.active)
      batch(() => {
        if (opening && openings[opening.id]) {
          const state = openings[opening.id]!
          const resolved = next.tabs.find((tab) => tab.id === next.active)!
          const active =
            openingActive[JSON.stringify([boundSession, entry.surface])] === opening.id ||
            target.active() === resolved.id
          setOpenings(opening.id, "tab", reconcile({ ...resolved, id: opening.id }))
          const upgraded = openings[opening.id]!.tab
          committed = upgraded
          const tabs = next.tabs.filter((tab) => tab.id !== resolved.id)
          tabs.splice(Math.max(0, Math.min(state.index, tabs.length)), 0, upgraded)
          target.setTabs(tabs)
          if (active) target.setActive(upgraded.id)
          removeOpening(opening.id)
          if (active) setOpeningActive(JSON.stringify([boundSession, entry.surface]), undefined)
          return
        }
        target.setTabs(next.tabs)
        if (options.activate !== false) {
          target.setActive(next.active)
          target.open()
        } else if (!target.active()) target.setActive(next.active)
      })
      return committed
    }

    async function closeBoundTab(boundSession: string, surfaceName: WorkbenchPanelSurface, tabId: string) {
      const opening = openings[tabId]
      const task = openingTasks.get(tabId)
      if (opening && task && opening.session === boundSession) {
        task.cancelled = true
        const tabs = projectedTabs(boundSession, surfaceName)
        const key = JSON.stringify([boundSession, surfaceName])
        const target = layout.surface(boundSession, surfaceName)
        const next = closeWorkbenchPanelTab(tabs, openingActive[key] ?? target.active(), tabId)
        batch(() => {
          removeOpening(tabId)
          target.setTabs(target.tabs().filter((tab) => tab.id !== tabId))
          if (openingActive[key] === tabId) setOpeningActive(key, undefined)
          if (sessionKey() === boundSession) surface(surfaceName).setActive(next.active)
          if (!projectedTabs(boundSession, surfaceName).length) target.close()
        })
        for (const handler of task.handlers) void Promise.resolve().then(handler).catch(reportOpeningCleanup)
        task.handlers.clear()
        return true
      }
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
        batch(() => {
          target.setTabs(next.tabs)
          target.setActive(next.active)
          if (!projectedTabs(boundSession, surfaceName).length) target.close()
        })
        return true
      } finally {
        closeGuard.end(guardKey)
      }
    }

    async function closeTab(tabId: string) {
      interact()
      const boundSession = sessionKey()
      for (const surfaceName of ["side", "bottom"] as const) {
        if (!projectedTabs(boundSession, surfaceName).some((tab) => tab.id === tabId)) continue
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
      const keep = projectedTabs(boundSession, surfaceName).find((item) => item.id === keepTabId)
      if (!keep) return

      batchClosingSurfaces.add(batchKey)
      try {
        const tabs = projectedTabs(boundSession, surfaceName)
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
        if (
          sessionKey() === boundSession &&
          projectedTabs(boundSession, surfaceName).some((tab) => tab.id === keepTabId)
        )
          surface(surfaceName).setActive(keepTabId)
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
      isCurrent(boundSession: string) {
        return !disposed() && sessionKey() === boundSession
      },
      surface,
      panels(surfaceName: WorkbenchPanelSurface) {
        return surfaceName === "side" ? sideEntries() : bottomEntries()
      },
      getPanel: visibleEntry,
      panelForTab,
      panelTitle,
      openPanel,
      openingForTab(tabId: string): WorkbenchPanelOpening | undefined {
        const state = openings[tabId]
        const task = openingTasks.get(tabId)
        if (!state || !task) return
        return {
          phase: state.phase,
          error: state.error,
          retry: task.run,
          resolve: async () => {
            const result = await task.run()
            if (task.cancelled || task.abandoned || disposed())
              throw new Error(
                i18n._({
                  id: "browser.prepare.closed",
                  message: "The browser target changed or closed. Reopen the import dialog.",
                }),
              )
            if (!result)
              throw (
                openings[tabId]?.error ??
                new Error(i18n._({ id: "browser.prepare.failed", message: "Browser preparation failed. Retry." }))
              )
            return result
          },
        }
      },
      showDialog(element: () => JSX.Element) {
        return dialog.show(element)
      },
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
