import { createContext, createMemo, createSignal, useContext, type ParentProps } from "solid-js"
import { createStore, produce, type SetStoreFunction } from "solid-js/store"

export interface BrowserTab {
  id: string
  title: string
  url: string
  isLoading: boolean
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
  state: "in_progress" | "completed" | "cancelled" | "interrupted"
  totalBytes: number
  receivedBytes: number
  timestamp: number
}

export interface AnnotationTarget {
  displayX: number
  displayY: number
  pageX: number
  pageY: number
}
export interface AssetEntry {
  url: string
  type: "image" | "script" | "stylesheet" | "font" | "media" | "other"
}

export type DevPanel = "closed" | "console" | "network" | "elements" | "screenshot" | "inspect" | "downloads" | "assets"

export function createBrowserStore() {
  const [session, setSession] = createStore({
    tabs: [] as BrowserTab[],
    activeTabId: null as string | null,
    connectionStatus: "disconnected" as string,
  })

  const [tabScreenshots, setTabScreenshots] = createStore<Record<string, ScreenshotEntry>>({})
  const [consoleEntries, setConsoleEntries] = createStore<Record<string, ConsoleEntry[]>>({})
  const [networkRequests, setNetworkRequests] = createStore<Record<string, NetworkEntry[]>>({})
  const [elements, setElements] = createStore<Record<string, AccessibilityElement[]>>({})
  const [pageAssets, setPageAssets] = createStore<Record<string, AssetEntry[]>>({})
  const [downloads, setDownloads] = createStore<Record<string, DownloadEntry[]>>({})
  const [devPanel, setDevPanel] = createSignal<DevPanel>("closed")
  const [agentActivity, setAgentActivity] = createSignal<string | null>(null)
  const [annotationMode, setAnnotationMode] = createSignal(false)
  const [viewportWidth, setViewportWidth] = createSignal(1280)

  const [viewportHeight, setViewportHeight] = createSignal(720)
  const [annotationTarget, setAnnotationTarget] = createSignal<AnnotationTarget | null>(null)

  const activeTabId = createMemo(() => session.activeTabId)

  const activeTab = createMemo(() => {
    const id = activeTabId()
    return session.tabs.find((t) => t.id === id) ?? null
  })

  let _sendFn: ((msg: Record<string, unknown>) => void) | undefined

  function send(msg: Record<string, unknown>) {
    _sendFn?.(msg)
  }

  function _setSend(fn: ((msg: Record<string, unknown>) => void) | undefined) {
    _sendFn = fn
  }

  function createTab(url?: string) {
    send({ type: "createTab", url })
  }

  function closeTab(tabId: string) {
    setSession(
      "tabs",
      produce((tabs) => {
        const idx = tabs.findIndex((t) => t.id === tabId)
        if (idx === -1) return
        tabs.splice(idx, 1)
      }),
    )
    if (session.activeTabId === tabId && session.tabs.length > 0) {
      setSession("activeTabId", session.tabs[0].id)
    }
  }

  function switchTab(tabId: string) {
    setSession("activeTabId", tabId)
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

  function setViewport(width: number, height: number) {
    setViewportWidth(width)
    setViewportHeight(height)
    send({ type: "setViewport", width, height })
  }

  function clearAnnotationTarget() {
    setAnnotationTarget(null)
  }
  return {
    session,
    setSession,
    activeTab,
    activeTabId,
    createTab,
    closeTab,
    switchTab,
    setTabLoading,
    setTabUrl,
    setTabTitle,
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
    viewportWidth,
    viewportHeight,
    setViewport,
    downloads,
    setDownloads,
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
