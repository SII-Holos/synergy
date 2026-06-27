import { createContext, createSignal, useContext, type ParentProps } from "solid-js"
import type { BrowserPresentationSelection } from "@ericsanchezok/synergy-util/browser-protocol"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { browserDebug, shouldLogBrowserMessage, summarizeBrowserMessage } from "./browser-debug"

export interface BrowserPage {
  id: string
  title: string
  url: string
  isLoading: boolean
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
  pageId: string | null
  url: string | null
  title?: string
  kind: "reading" | "acting" | "idle"
  tool?: string
  label: string | null
}

export interface FileChooserRequest {
  pageId: string
  requestId: string
  multiple: boolean
  accept: string[]
}

export interface DialogRequest {
  pageId: string
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

export type BrowserHostStatus = "pending" | "ready" | "detached" | "restarting" | "failed"

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

function createBrowserTraceId() {
  const random = globalThis.crypto?.randomUUID?.()
  if (random) return `browser_${random}`
  return `browser_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

export function createBrowserStore() {
  const [session, setSession] = createStore({
    page: null as BrowserPage | null,
    connectionStatus: "disconnected" as "disconnected" | "connecting" | "connected" | "failed" | "error",
    controlMode: "user" as "user" | "agent",
  })

  const [pageScreenshots, setPageScreenshots] = createStore<Record<string, ScreenshotEntry>>({})
  const [consoleEntries, setConsoleEntries] = createStore<Record<string, ConsoleEntry[]>>({})
  const [networkRequests, setNetworkRequests] = createStore<Record<string, NetworkEntry[]>>({})
  const [elements, setElements] = createStore<Record<string, AccessibilityElement[]>>({})
  const [pageAssets, setPageAssets] = createStore<Record<string, AssetEntry[]>>({})
  const [downloads, setDownloads] = createStore<Record<string, DownloadEntry[]>>({})
  const [hostStatuses, setHostStatuses] = createStore<Record<string, BrowserHostStatus>>({})
  const [devPanel, setDevPanel] = createSignal<DevPanel>("closed")
  const [agentActivity, setAgentActivity] = createSignal<AgentActivity>({
    pageId: null,
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
  const [viewportHeight, setViewportHeight] = createSignal(720)
  const [presentation, setPresentation] = createSignal<BrowserPresentationSelection | null>(null)
  const [annotationTarget, setAnnotationTarget] = createSignal<AnnotationTarget | null>(null)
  const [browserTraceId] = createSignal(createBrowserTraceId())
  const pendingViewportByPage = new Map<string, Record<string, unknown>>()

  const page = () => session.page
  const pageId = () => session.page?.id ?? null

  let _sendFn: ((msg: Record<string, unknown>) => void) | undefined

  function send(msg: Record<string, unknown>) {
    if (shouldLogBrowserMessage(msg)) {
      browserDebug("store.send", {
        ...summarizeBrowserMessage(msg),
        hasSender: Boolean(_sendFn),
        connectionStatus: session.connectionStatus,
        pageId: pageId(),
        hasPage: Boolean(session.page),
      })
    }
    if (!_sendFn) browserDebug("store.send.dropped", { reason: "missing sender", type: msg.type })
    _sendFn?.(msg)
  }

  function _setSend(fn: ((msg: Record<string, unknown>) => void) | undefined) {
    _sendFn = fn
    browserDebug("store.sender", { installed: Boolean(fn) })
  }

  function navigate(url: string) {
    const current = page()
    browserDebug("store.navigate", {
      url,
      pageId: current?.id ?? null,
      currentUrl: current?.url ?? null,
      connectionStatus: session.connectionStatus,
    })
    setFollowAgent(false)
    if (current) setPageLoading(current.id, true)
    send({ type: "navigate", source: "user", url, pageId: current?.id })
  }

  function setPageLoading(nextPageId: string | null | undefined, isLoading: boolean) {
    if (!nextPageId || session.page?.id !== nextPageId) return
    setSession("page", "isLoading", isLoading)
  }

  function setPageUrl(nextPageId: string | null | undefined, url: string) {
    if (!nextPageId || session.page?.id !== nextPageId) return
    setSession("page", "url", url)
  }

  function setPageTitle(nextPageId: string | null | undefined, title: string) {
    if (!nextPageId || session.page?.id !== nextPageId) return
    setSession("page", "title", title)
  }

  function upsertPage(nextPage: BrowserPage | null | undefined) {
    if (!nextPage) {
      setSession("page", null)
      return
    }
    setSession("page", nextPage)
  }

  function removePage(nextPageId: string | null | undefined) {
    if (!nextPageId || session.page?.id !== nextPageId) return
    setSession("page", null)
  }

  function requestScreenshot() {
    const id = pageId()
    if (!id) return
    send({ type: "requestScreenshot", pageId: id })
  }

  function toggleDevPanel(panel: DevPanel) {
    setDevPanel((prev) => (prev === panel ? "closed" : panel))
  }

  function setViewport(width: number, height: number, options: SetViewportOptions = {}) {
    const nextWidth = Math.max(1, Math.round(width))
    const nextHeight = Math.max(1, Math.round(height))

    setViewportMode(options.mode ?? "fixed")
    setViewportWidth(nextWidth)
    setViewportHeight(nextHeight)
    const id = pageId()
    const message = {
      type: "input.resize",
      pageId: id,
      width: nextWidth,
      height: nextHeight,
    }
    if (!id) {
      browserDebug("store.viewport.local", {
        width: nextWidth,
        height: nextHeight,
        reason: "missing-page",
      })
      return
    }
    if (presentation()?.kind === "webrtc" && hostStatus(id) !== "ready") {
      pendingViewportByPage.set(id, message)
      browserDebug("store.viewport.deferred", {
        pageId: id,
        width: nextWidth,
        height: nextHeight,
        hostStatus: hostStatus(id),
      })
      return
    }
    send(message)
  }

  function clearAnnotationTarget() {
    setAnnotationTarget(null)
  }

  function setFollowAgent(enabled: boolean) {
    setFollowAgentSignal(enabled)
    send({ type: "setFollowAgent", enabled })
  }

  function followAgentNow() {
    setFollowAgent(true)
  }

  function applyAgentActivity(activity: AgentActivity) {
    setAgentActivity(activity)
  }

  function addDownload(nextPageId: string, entry: DownloadEntry) {
    const current = downloads[nextPageId] ?? []
    const index = current.findIndex((item) => item.id === entry.id)
    if (index === -1) {
      setDownloads(nextPageId, [...current, entry])
      return
    }
    setDownloads(nextPageId, index, entry)
  }

  function hostStatus(id = pageId()): BrowserHostStatus {
    if (!id) return "detached"
    return hostStatuses[id] ?? "detached"
  }

  function setHostStatus(nextPageId: string | null | undefined, status: BrowserHostStatus) {
    if (!nextPageId) return
    setHostStatuses(nextPageId, status)
    if (status !== "ready") return
    clearTransientHostError()
    const pending = pendingViewportByPage.get(nextPageId)
    if (!pending) return
    pendingViewportByPage.delete(nextPageId)
    browserDebug("store.viewport.flush", summarizeBrowserMessage(pending))
    send(pending)
  }

  function clearTransientHostError() {
    const error = browserError()
    if (!error) return
    if (
      error.code === "browser_host_disconnected" ||
      error.code === "browser_host_pending" ||
      error.message.includes("Browser Host control is not attached")
    ) {
      setBrowserError(null)
    }
  }

  return {
    session,
    setSession,
    page,
    pageId,
    navigate,
    setPageLoading,
    setPageUrl,
    setPageTitle,
    upsertPage,
    removePage,
    send,
    _setSend,
    requestScreenshot,
    toggleDevPanel,
    pageScreenshots,
    setPageScreenshots,
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
    browserTraceId,
    hostStatus,
    hostStatuses,
    setHostStatus,
    clearTransientHostError,
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
