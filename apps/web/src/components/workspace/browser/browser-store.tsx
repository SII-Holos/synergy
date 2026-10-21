import { updateBrowserActivities, type BrowserAgentActivity } from "@ericsanchezok/synergy-browser-core"
import {
  createComponent,
  createContext,
  createMemo,
  createSignal,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import type {
  BrowserDownloadEntry,
  BrowserEvent as BrowserProtocolEvent,
  BrowserHostStatus,
  BrowserPage as BrowserProtocolPage,
  BrowserAPISessionPage,
  BrowserPresentationSelection,
} from "@ericsanchezok/synergy-browser-core"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { createStore, reconcile } from "solid-js/store"
import { browserDebug, shouldLogBrowserMessage, summarizeBrowserMessage } from "./browser-debug"

export type BrowserPage = BrowserAPISessionPage

export interface ConsoleEntry {
  level: string
  text: string
  timestamp: number
  stackTrace?: string
}

export interface NetworkEntry {
  requestId: string
  url: string
  method: string
  status?: number
  type: string
  timestamp: number
}

export interface AccessibilityElement {
  ref: string
  role: string
  name: string
  value?: string
  children: AccessibilityElement[]
}

export type DownloadEntry = BrowserDownloadEntry & { pageId?: string }

const emptyActivity = { pageId: null, url: null, kind: "idle" as const, label: null }

export type FileChooserRequest = Pick<
  Extract<BrowserProtocolEvent, { type: "filechooser.request" }>,
  "pageId" | "requestId" | "multiple" | "accept"
>

type DialogEvent = Extract<BrowserProtocolEvent, { type: "dialog.opened" }>
export type DialogRequest = Pick<DialogEvent, "pageId" | "requestId" | "message" | "defaultValue"> & {
  type: DialogEvent["dialogType"]
}

export interface BrowserErrorState {
  navigation?: BrowserProtocolPage["navigation"]
  pageId?: string
  severity: "warning" | "error" | "critical"
  message: string
  code?: string
}

export interface AnnotationTarget {
  displayX: number
  displayY: number
  pageX: number
  pageY: number
}

export interface AssetEntry {
  url: string
  type: "image" | "script" | "stylesheet" | "font" | "media" | "document" | "other"
}

export type DevPanel = "closed" | "console" | "network" | "elements" | "downloads" | "assets"
export type ViewportMode = "fit" | "fixed"
export interface SetViewportOptions {
  mode?: ViewportMode
}

type BrowserSender = (message: Record<string, unknown>) => void | Promise<BrowserPage | void>

export function createBrowserStore() {
  const [session, setSession] = createStore({
    pages: [] as BrowserPage[],
    connectionStatus: "disconnected" as "disconnected" | "connecting" | "connected" | "failed" | "error",
    controlMode: "user" as "user" | "agent",
    seq: 0,
    epoch: null as string | null,
  })
  const [consoleEntries, setConsoleEntries] = createStore<Record<string, ConsoleEntry[]>>({})
  const [networkRequests, setNetworkRequests] = createStore<Record<string, NetworkEntry[]>>({})
  const [elements, setElements] = createStore<Record<string, AccessibilityElement[]>>({})
  const [pageAssets, setPageAssets] = createStore<Record<string, AssetEntry[]>>({})
  const [downloads, setDownloads] = createStore<Record<string, DownloadEntry[]>>({})
  const [hostStatuses, setHostStatuses] = createStore<Record<string, BrowserHostStatus>>({})
  const [activityState, setActivityState] = createStore({ items: [] as BrowserAgentActivity[] })
  const [fileChoosers, setFileChoosers] = createStore<Record<string, FileChooserRequest | undefined>>({})
  const [dialogs, setDialogs] = createStore<Record<string, DialogRequest | undefined>>({})
  const [pageErrors, setPageErrors] = createStore<Record<string, BrowserErrorState | undefined>>({})
  const [presentation, setPresentation] = createSignal<BrowserPresentationSelection | null>(null)
  const browserTraceId = `browser_${generateUUID()}`
  let sender: BrowserSender | undefined

  function replacePages(pages: BrowserPage[]) {
    const merged = pages.map((next) => {
      const current = session.pages.find((page) => page.id === next.id)
      return current && olderNavigation(next, current) ? current : next
    })
    setSession("pages", reconcile(merged, { key: "id" }))
  }
  function setBrowserError(error: BrowserErrorState | null) {
    if (error?.code === "browser_command_cancelled") return
    if (error?.navigation) {
      const current = session.pages.find((page) => page.id === error.pageId)?.navigation
      if (
        current &&
        (current.generation !== error.navigation.generation ||
          current.id !== error.navigation.id ||
          current.phase !== "failed")
      )
        return
    }
    setPageErrors(error?.pageId ?? "global", error ?? undefined)
  }
  function clearPageError(id: string) {
    setPageErrors(id, undefined)
  }
  function send(message: Record<string, unknown>) {
    if (shouldLogBrowserMessage(message))
      browserDebug("store.send", {
        ...summarizeBrowserMessage(message),
        hasSender: Boolean(sender),
        connectionStatus: session.connectionStatus,
      })
    if (!sender) browserDebug("store.send.dropped", { reason: "missing sender", type: message.type })
    return sender?.(message)
  }
  function setPageLoading(id: string | null | undefined, value: boolean) {
    setSession("pages", (page) => page.id === id, "isLoading", value)
  }
  function setPageUrl(id: string | null | undefined, value: string) {
    setSession("pages", (page) => page.id === id, "url", value)
  }
  function setPageTitle(id: string | null | undefined, value: string) {
    setSession("pages", (page) => page.id === id, "title", value)
  }
  function upsertPage(next: BrowserProtocolPage | BrowserPage | null | undefined) {
    if (!next) return
    const index = session.pages.findIndex((page) => page.id === next.id)
    if (index >= 0) {
      const current = session.pages[index]!.navigation
      const incoming = next.navigation
      if (olderNavigation(next, session.pages[index]!)) return
      if (
        incoming &&
        (incoming.id !== current?.id || (incoming.phase === "completed" && current?.phase !== "completed"))
      )
        clearPageError(next.id)
      setSession("pages", index, reconcile({ ...session.pages[index], ...next }, { key: null }))
    } else if ("profileId" in next) setSession("pages", [...session.pages, next])
  }
  function removePage(id: string | null | undefined) {
    if (!id) return
    replacePages(session.pages.filter((page) => page.id !== id))
    setDialogs(id, undefined)
    setFileChoosers(id, undefined)
    setPageErrors(id, undefined)
    replaceAgentActivities(activityState.items.filter((item) => item.pageId !== id))
    setHostStatuses(id, undefined!)
    setConsoleEntries(id, undefined!)
    setNetworkRequests(id, undefined!)
    setElements(id, undefined!)
    setPageAssets(id, undefined!)
  }
  function replaceAgentActivities(activities: BrowserAgentActivity[]) {
    setActivityState("items", reconcile(activities, { key: null }))
  }
  function applyAgentActivity(activity: BrowserAgentActivity) {
    replaceAgentActivities(updateBrowserActivities(activityState.items, activity))
  }
  function agentActivitiesFor(sessionID: string | undefined) {
    return activityState.items.filter(
      (item) => item.sessionID === sessionID && session.pages.some((page) => page.id === item.pageId),
    )
  }
  function addDownload(nextPageId: string, entry: DownloadEntry) {
    entry = { ...entry, pageId: nextPageId }
    for (const [key, entries] of Object.entries(downloads)) {
      const index = entries.findIndex((item) => item.id === entry.id)
      if (index !== -1) setDownloads(key, index, entry)
    }
    const current = downloads[nextPageId] ?? []
    const index = current.findIndex((item) => item.id === entry.id)
    if (index === -1) setDownloads(nextPageId, [...current, entry])
    else setDownloads(nextPageId, index, entry)
  }
  function clearTransientHostError(id = "global") {
    if (id !== "global" && session.pages.find((page) => page.id === id)?.status !== "active") return
    const error = pageErrors[id]
    if (
      error &&
      (error.code === "browser_host_disconnected" ||
        error.code === "browser_host_pending" ||
        error.code === "browser_native_host_connecting" ||
        error.message.includes("Browser Host control is not attached"))
    )
      clearPageError(id)
  }
  function setHostStatus(id: string | null | undefined, status: BrowserHostStatus) {
    if (!id) return
    setHostStatuses(id, status)
    if (status === "ready") clearTransientHostError(id)
  }
  const shared = {
    session,
    setSession,
    replacePages,
    setPageLoading,
    setPageUrl,
    setPageTitle,
    upsertPage,
    removePage,
    send,
    _setSend: (fn: BrowserSender | undefined) => {
      sender = fn
    },
    consoleEntries,
    setConsoleEntries,
    networkRequests,
    setNetworkRequests,
    elements,
    setElements,
    pageAssets,
    setPageAssets,
    downloads,
    setDownloads,
    addDownload,
    agentActivitiesFor,
    replaceAgentActivities,
    applyAgentActivity,
    dialogs,
    fileChoosers,
    pageErrors,
    setDialogRequest: (request: DialogRequest) => setDialogs(request.pageId, request),
    setFileChooserRequest: (request: FileChooserRequest) => setFileChoosers(request.pageId, request),
    presentation,
    setPresentation,
    setBrowserError,
    clearPageError,
    hostStatuses,
    setHostStatus,
    clearTransientHostError,
    browserTraceId: () => browserTraceId,
  }

  function forPage(
    target: Accessor<string | undefined>,
    selectPage: (id: string) => void,
    sessionID: Accessor<string | undefined> = () => undefined,
  ) {
    const recentAgentActivity = createMemo(() =>
      agentActivitiesFor(sessionID())
        .filter((item) => item.kind === "idle")
        .at(-1),
    )
    const activeAgentActivities = createMemo(() =>
      agentActivitiesFor(sessionID()).filter((item) => item.kind !== "idle"),
    )
    const agentActivity = createMemo(() => activeAgentActivities().at(-1) ?? recentAgentActivity() ?? emptyActivity)
    const page = createMemo(() => session.pages.find((page) => page.id === target()) ?? null)
    const pageId = createMemo(() => page()?.id ?? null)
    const [devPanel, setDevPanel] = createSignal<DevPanel>("closed")
    const [controlsOpen, setControlsOpen] = createSignal(false)
    const [addressSuggestionsOpen, setAddressSuggestionsOpen] = createSignal(false)
    const [annotationMode, setAnnotationMode] = createSignal(false)
    const [annotationTarget, setAnnotationTarget] = createSignal<AnnotationTarget | null>(null)
    const [viewportMode, setViewportMode] = createSignal<ViewportMode>("fit")
    const [viewportWidth, setViewportWidth] = createSignal(1280)
    const [viewportHeight, setViewportHeight] = createSignal(720)
    const [followAgent, setFollowAgent] = createSignal(false)
    const sendPage = (message: Record<string, unknown>) => send({ pageId: target(), ...message })
    const openPage = async (url = "about:blank", profileId?: string) => {
      const opened = await sendPage({ type: "page.open", url, profileId })
      if (opened) selectPage(opened.id)
    }
    const setError = (error: BrowserErrorState | null) => {
      const id = target()
      const key = error ? (error.pageId ?? id ?? "global") : id && pageErrors[id] ? id : "global"
      setPageErrors(key, error ?? undefined)
    }
    return {
      ...shared,
      agentActivity,
      recentAgentActivity,
      activeAgentActivities,
      page,
      pageId,
      selectPage,
      openPage,
      send: sendPage,
      navigate(url: string) {
        setFollowAgent(false)
        const current = page()
        if (current) {
          setPageLoading(current.id, true)
          void sendPage({ type: "navigate", source: "user", url })
        } else if (!target()) void openPage(url)
      },
      devPanel,
      setDevPanel,
      toggleDevPanel: (panel: DevPanel) => setDevPanel((previous) => (previous === panel ? "closed" : panel)),
      controlsOpen,
      setControlsOpen,
      addressSuggestionsOpen,
      setAddressSuggestionsOpen,
      annotationMode,
      setAnnotationMode,
      annotationTarget,
      setAnnotationTarget,
      clearAnnotationTarget: () => setAnnotationTarget(null),
      viewportMode,
      viewportWidth,
      viewportHeight,
      setViewport(width: number, height: number, options: SetViewportOptions = {}) {
        const nextWidth = Math.max(1, Math.round(width)),
          nextHeight = Math.max(1, Math.round(height))
        setViewportMode(options.mode ?? "fixed")
        setViewportWidth(nextWidth)
        setViewportHeight(nextHeight)
        if (page()?.status === "active")
          void sendPage({
            type: "input.resize",
            width: nextWidth,
            height: nextHeight,
            ...(options.mode === "fit" ? { mode: "fit" } : {}),
          })
      },
      followAgent,
      setFollowAgent,
      followAgentNow() {
        const id = agentActivity().pageId
        if (id) selectPage(id)
      },
      fileChooserRequest: () => fileChoosers[target() ?? ""] ?? null,
      setFileChooserRequest: (request: FileChooserRequest | null) =>
        setFileChoosers(request?.pageId ?? target() ?? "", request ?? undefined),
      dialogRequest: () => dialogs[target() ?? ""] ?? null,
      setDialogRequest: (request: DialogRequest | null) =>
        setDialogs(request?.pageId ?? target() ?? "", request ?? undefined),
      browserError: () => pageErrors[target() ?? ""] ?? pageErrors.global ?? null,
      setBrowserError: setError,
      hostStatus: (id = pageId()): BrowserHostStatus => (id ? (hostStatuses[id] ?? "detached") : "detached"),
    }
  }
  return { ...shared, forPage }
}

export type BrowserStoreAPI = ReturnType<typeof createBrowserStore>
export type BrowserPageStoreAPI = ReturnType<BrowserStoreAPI["forPage"]>
const BrowserContext = createContext<BrowserPageStoreAPI>()
export function BrowserStoreProvider(props: ParentProps & { store: BrowserPageStoreAPI }) {
  return createComponent(BrowserContext.Provider, {
    get value() {
      return props.store
    },
    get children() {
      return props.children
    },
  })
}
export function useBrowser() {
  const ctx = useContext(BrowserContext)
  if (!ctx) throw new Error("useBrowser must be used within BrowserStoreProvider")
  return ctx
}

function olderNavigation(next: BrowserProtocolPage, current: BrowserProtocolPage): boolean {
  const incoming = next.navigation
  const previous = current.navigation
  return Boolean(
    previous &&
    incoming &&
    (incoming.generation < previous.generation ||
      (incoming.generation === previous.generation && incoming.revision < previous.revision)),
  )
}
