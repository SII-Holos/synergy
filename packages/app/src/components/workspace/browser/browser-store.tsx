import { createContext, createSignal, useContext, type ParentProps } from "solid-js"
import type { BrowserPresentationSelection } from "@ericsanchezok/synergy-util/browser-protocol"
import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import { browserDebug, shouldLogBrowserMessage, summarizeBrowserMessage } from "./browser-debug"

export interface BrowserTab {
  id: string
  title: string
  url: string
  isLoading: boolean
  pinned?: boolean
  kept?: boolean
  lastActiveAt?: number | null
}

export interface ScreenshotEntry {
  url: string
  width: number
  height: number
}

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
export interface DownloadEntry {
  id: string
  url: string
  fileName: string
  mimeType: string
  state: "in_progress" | "completed" | "cancelled" | "interrupted" | "blocked"
  totalBytes: number
  receivedBytes: number
  timestamp: number
  path?: string
  warning?: string
}

export interface AgentActivity {
  tabId: string | null
  url: string | null
  title?: string
  kind: "reading" | "acting" | "idle"
  tool?: string
  label: string | null
}

export interface FileChooserRequest {
  tabId: string
  requestId: string
  multiple: boolean
  accept: string[]
}

export interface DialogRequest {
  tabId: string
  requestId: string
  type: string
  message: string
  defaultValue?: string
}

export interface BrowserErrorState {
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

export type DevPanel = "closed" | "console" | "network" | "elements" | "screenshot" | "inspect" | "downloads" | "assets"
export type ViewportMode = "fit" | "fixed"

export interface SetViewportOptions {
  mode?: ViewportMode
}

export function createBrowserStore() {
  const [session, setSession] = createStore({
    tabs: [] as BrowserTab[],
    activeTabId: null as string | null,
    visibleTabId: null as string | null,
    connectionStatus: "disconnected" as "disconnected" | "connecting" | "connected" | "failed" | "error",
    controlMode: "user" as "user" | "agent",
  })

  const [tabScreenshots, setTabScreenshots] = createStore<Record<string, ScreenshotEntry>>({})
  const [consoleEntries, setConsoleEntries] = createStore<Record<string, ConsoleEntry[]>>({})
  const [networkRequests, setNetworkRequests] = createStore<Record<string, NetworkEntry[]>>({})
  const [elements, setElements] = createStore<Record<string, AccessibilityElement[]>>({})
  const [pageAssets, setPageAssets] = createStore<Record<string, AssetEntry[]>>({})
  const [downloads, setDownloads] = createStore<Record<string, DownloadEntry[]>>({})
  const [devPanel, setDevPanel] = createSignal<DevPanel>("closed")
  const [agentActivity, setAgentActivity] = createSignal<AgentActivity>({
    tabId: null,
    url: null,
    kind: "idle",
    label: null,
  })
  const [followAgent, setFollowAgentSignal] = createSignal(true)
  const [fileChooserRequest, setFileChooserRequest] = createSignal<FileChooserRequest | null>(null)
  const [dialogRequest, setDialogRequest] = createSignal<DialogRequest | null>(null)
  const [browserError, setBrowserError] = createSignal<BrowserErrorState | null>(null)
  const [annotationMode, setAnnotationMode] = createSignal(false)
  const [viewportMode, setViewportMode] = createSignal<ViewportMode>("fit")
  const [viewportWidth, setViewportWidth] = createSignal(1280)
  const [presentation, setPresentation] = createSignal<BrowserPresentationSelection | null>(null)

  const [viewportHeight, setViewportHeight] = createSignal(720)
  const [annotationTarget, setAnnotationTarget] = createSignal<AnnotationTarget | null>(null)

  const activeTabId = () => session.visibleTabId ?? session.activeTabId

  const activeTab = () => {
    const id = activeTabId()
    return session.tabs.find((t) => t.id === id) ?? null
  }

  let _sendFn: ((msg: Record<string, unknown>) => void) | undefined

  function send(msg: Record<string, unknown>) {
    if (shouldLogBrowserMessage(msg)) {
      browserDebug("store.send", {
        ...summarizeBrowserMessage(msg),
        hasSender: Boolean(_sendFn),
        connectionStatus: session.connectionStatus,
        activeTabId: activeTabId(),
        tabCount: session.tabs.length,
      })
    }
    if (!_sendFn) browserDebug("store.send.dropped", { reason: "missing sender", type: msg.type })
    _sendFn?.(msg)
  }

  function _setSend(fn: ((msg: Record<string, unknown>) => void) | undefined) {
    _sendFn = fn
    browserDebug("store.sender", { installed: Boolean(fn) })
  }

  function createTab(url?: string) {
    browserDebug("store.createTab", { url, activeTabId: activeTabId(), tabCount: session.tabs.length })
    send({ type: "createTab", url })
  }

  function navigate(url: string) {
    browserDebug("store.navigate", {
      url,
      activeTabId: activeTabId(),
      activeTabUrl: activeTab()?.url ?? null,
      connectionStatus: session.connectionStatus,
      tabCount: session.tabs.length,
    })
    setFollowAgent(false)
    const tab = activeTab()
    if (!tab) {
      browserDebug("store.navigate.createTab", { url })
      createTab(url)
      return
    }

    setTabLoading(tab.id, true)
    browserDebug("store.navigate.activeTab", { url, tabId: tab.id, previousUrl: tab.url })
    send({ type: "navigate", source: "user", url, tabId: tab.id })
  }

  function closeTab(tabId: string) {
    send({ type: "closeTab", tabId })
  }

  function switchTab(tabId: string) {
    setFollowAgent(false)
    setSession("visibleTabId", tabId)
    setSession("activeTabId", tabId)
    send({ type: "switchTab", tabId, reason: "user" })
  }

  function activateTabFromServer(tabId: string) {
    setSession("activeTabId", tabId)
    if (!session.visibleTabId || followAgent()) setSession("visibleTabId", tabId)
  }

  function setTabLoading(tabId: string, isLoading: boolean) {
    setSession("tabs", (t: BrowserTab) => t.id === tabId, "isLoading", isLoading)
  }

  function setTabUrl(tabId: string, url: string) {
    setSession("tabs", (t: BrowserTab) => t.id === tabId, "url", url)
  }

  function setTabTitle(tabId: string, title: string) {
    setSession("tabs", (t: BrowserTab) => t.id === tabId, "title", title)
  }

  function requestScreenshot() {
    send({ type: "requestScreenshot" })
  }

  function toggleDevPanel(panel: DevPanel) {
    setDevPanel((prev) => (prev === panel ? "closed" : panel))
  }

  function setViewport(width: number, height: number, options: SetViewportOptions = {}) {
    const nextWidth = Math.max(1, Math.round(width))
    const nextHeight = Math.max(1, Math.round(height))
    const deviceScaleFactor = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1

    setViewportMode(options.mode ?? "fixed")
    setViewportWidth(nextWidth)
    setViewportHeight(nextHeight)
    send({
      type: "input.resize",
      tabId: activeTabId(),
      width: nextWidth,
      height: nextHeight,
      deviceScaleFactor,
    })
  }

  function clearAnnotationTarget() {
    setAnnotationTarget(null)
  }

  function setFollowAgent(enabled: boolean) {
    setFollowAgentSignal(enabled)
    send({ type: "setFollowAgent", enabled })
  }

  function followAgentNow() {
    const activity = agentActivity()
    if (!activity.tabId) return
    setFollowAgent(true)
    setSession("visibleTabId", activity.tabId)
  }

  function applyAgentActivity(activity: AgentActivity) {
    setAgentActivity(activity)
    if (activity.kind === "idle" || !activity.tabId) return
    if (followAgent()) {
      setSession("visibleTabId", activity.tabId)
    }
  }

  function upsertTab(tab: BrowserTab) {
    const existing = session.tabs.findIndex((t) => t.id === tab.id)
    if (existing === -1) {
      setSession("tabs", [...session.tabs, tab])
      return
    }
    setSession("tabs", (t: BrowserTab) => t.id === tab.id, tab)
  }

  function removeTab(tabId: string) {
    setSession(
      "tabs",
      produce((tabs) => {
        const idx = tabs.findIndex((t) => t.id === tabId)
        if (idx !== -1) tabs.splice(idx, 1)
      }),
    )
    if (session.visibleTabId === tabId) {
      setSession("visibleTabId", session.tabs.find((t) => t.id !== tabId)?.id ?? null)
    }
    if (session.activeTabId === tabId) {
      setSession("activeTabId", session.tabs.find((t) => t.id !== tabId)?.id ?? null)
    }
  }

  function addDownload(tabId: string, entry: DownloadEntry) {
    const current = downloads[tabId] ?? []
    const index = current.findIndex((item) => item.id === entry.id)
    if (index === -1) {
      setDownloads(tabId, [...current, entry])
      return
    }
    setDownloads(tabId, index, entry)
  }
  return {
    session,
    setSession,
    activeTab,
    activeTabId,
    createTab,
    navigate,
    closeTab,
    switchTab,
    setTabLoading,
    setTabUrl,
    setTabTitle,
    activateTabFromServer,
    upsertTab,
    removeTab,
    send,
    _setSend,
    requestScreenshot,
    toggleDevPanel,
    tabScreenshots,
    setTabScreenshots,
    consoleEntries,
    setConsoleEntries,
    networkRequests,
    setNetworkRequests,
    elements,
    setElements,
    pageAssets,
    setPageAssets,
    devPanel,
    setDevPanel,
    agentActivity,
    setAgentActivity,
    annotationMode,
    setAnnotationMode,
    annotationTarget,
    setAnnotationTarget,
    clearAnnotationTarget,
    viewportMode,
    viewportWidth,
    viewportHeight,
    presentation,
    setPresentation,
    setViewport,
    downloads,
    setDownloads,
    addDownload,
    followAgent,
    setFollowAgent,
    followAgentNow,
    applyAgentActivity,
    fileChooserRequest,
    setFileChooserRequest,
    dialogRequest,
    setDialogRequest,
    browserError,
    setBrowserError,
  }
}

export type BrowserStoreAPI = ReturnType<typeof createBrowserStore>

const BrowserContext = createContext<BrowserStoreAPI>()

export function BrowserStoreProvider(props: ParentProps & { store: BrowserStoreAPI }) {
  return <BrowserContext.Provider value={props.store}>{props.children}</BrowserContext.Provider>
}

export function useBrowser() {
  const ctx = useContext(BrowserContext)
  if (!ctx) throw new Error("useBrowser must be used within BrowserStoreProvider")
  return ctx
}
