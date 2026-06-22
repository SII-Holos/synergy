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

export type DevPanel = "closed" | "console" | "network" | "elements" | "screenshot" | "inspect"

let nextTabId = 1

function newTabId(): string {
  return `tab-${nextTabId++}`
}

let _globalSend: ((msg: Record<string, unknown>) => void) | undefined

export function createBrowserStore() {
  const startUrl = "about:blank"

  const [session, setSession] = createStore({
    tabs: [{ id: newTabId(), title: "New Tab", url: startUrl, isLoading: false }] as BrowserTab[],
    activeTabId: "tab-1" as string | null,
    connectionStatus: "disconnected" as string,
  })

  const [tabScreenshots, setTabScreenshots] = createStore<Record<string, ScreenshotEntry>>({})
  const [consoleEntries, setConsoleEntries] = createStore<Record<string, ConsoleEntry[]>>({})
  const [networkRequests, setNetworkRequests] = createStore<Record<string, NetworkEntry[]>>({})
  const [elements, setElements] = createStore<Record<string, AccessibilityElement[]>>({})
  const [devPanel, setDevPanel] = createSignal<DevPanel>("closed")
  const [agentActivity, setAgentActivity] = createSignal<string | null>(null)
  const [annotationMode, setAnnotationMode] = createSignal(false)

  const activeTabId = createMemo(() => session.activeTabId)

  const activeTab = createMemo(() => {
    const id = activeTabId()
    return session.tabs.find((t) => t.id === id) ?? null
  })

  function addTab(url?: string) {
    const id = newTabId()
    setSession(
      "tabs",
      produce((tabs) => {
        tabs.push({ id, title: "New Tab", url: url ?? startUrl, isLoading: false })
      }),
    )
    setSession("activeTabId", id)
    return id
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
    setSession("tabs", (t) => t.id === tabId, "isLoading", isLoading)
  }

  function setTabUrl(tabId: string, url: string) {
    setSession("tabs", (t) => t.id === tabId, "url", url)
  }

  function setTabTitle(tabId: string, title: string) {
    setSession("tabs", (t) => t.id === tabId, "title", title)
  }

  function send(msg: Record<string, unknown>) {
    _globalSend?.(msg)
  }

  function requestScreenshot() {
    send({ type: "request_screenshot" })
  }

  function toggleDevPanel(panel: DevPanel) {
    setDevPanel((prev) => (prev === panel ? "closed" : panel))
  }

  return {
    session,
    setSession,
    activeTab,
    activeTabId,
    addTab,
    closeTab,
    switchTab,
    setTabLoading,
    setTabUrl,
    setTabTitle,
    send,
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
    devPanel,
    setDevPanel,
    agentActivity,
    setAgentActivity,
    annotationMode,
    setAnnotationMode,
  }
}

export type BrowserStoreAPI = ReturnType<typeof createBrowserStore>

// Global singleton for direct imports (used by dev-toolbar.tsx, screenshot-canvas.tsx, console-panel.tsx, network-panel.tsx)
let globalStore: BrowserStoreAPI | undefined

export const BrowserStore = {
  get activeTabId() {
    return globalStore?.activeTabId
  },
  get tabScreenshots() {
    return globalStore?.tabScreenshots
  },
  get tabConsole() {
    return globalStore?.consoleEntries
  },
  get tabNetwork() {
    return globalStore?.networkRequests
  },
  get devPanel() {
    return globalStore?.devPanel
  },
  get session() {
    return globalStore?.session
  },
  requestScreenshot() {
    globalStore?.requestScreenshot()
  },
  toggleDevPanel(panel: DevPanel) {
    globalStore?.toggleDevPanel(panel)
  },
  send(msg: Record<string, unknown>) {
    globalStore?.send(msg)
  },
}

const BrowserContext = createContext<BrowserStoreAPI>()

export function BrowserStoreProvider(props: ParentProps) {
  const store = createBrowserStore()
  globalStore = store
  return <BrowserContext.Provider value={store}>{props.children}</BrowserContext.Provider>
}

export function useBrowser() {
  const ctx = useContext(BrowserContext)
  if (!ctx) throw new Error("useBrowser must be used within BrowserStoreProvider")
  return ctx
}

export function setGlobalSend(fn: ((msg: Record<string, unknown>) => void) | undefined) {
  _globalSend = fn
}
