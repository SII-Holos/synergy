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
  const [devPanel, setDevPanel] = createSignal<DevPanel>("closed")
  const [agentActivity, setAgentActivity] = createSignal<string | null>(null)
  const [annotationMode, setAnnotationMode] = createSignal(false)

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
    devPanel,
    setDevPanel,
    agentActivity,
    setAgentActivity,
    annotationMode,
    setAnnotationMode,
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
