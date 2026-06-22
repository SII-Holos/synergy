import { onCleanup, onMount } from "solid-js"
import { useSDK } from "@/context/sdk"
import { setGlobalSend } from "./browser-store"
import type { BrowserStoreAPI } from "./browser-store"

const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_DELAY = 2000

export function createBrowserWebSocket(store: BrowserStoreAPI, sessionID: string) {
  const sdk = useSDK()
  let ws: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let reconnectAttempts = 0

  const send = (msg: Record<string, unknown>) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  // Register the global send bridge so BrowserStore.send() routes through this WS.
  setGlobalSend(send)

  const connect = () => {
    if (disposed) return
    const wsUrl =
      sdk.url.replace(/^http/, "ws") +
      `/${encodeURIComponent(sdk.directory)}/browser/connect?mode=session&sessionID=${encodeURIComponent(sessionID)}`
    const socket = new WebSocket(wsUrl)
    ws = socket

    socket.addEventListener("open", () => {
      reconnectAttempts = 0
      store.setSession("connectionStatus", "connected")
    })

    socket.addEventListener("message", (event) => {
      let msg: any
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }

      switch (msg.type) {
        case "session.state": {
          if (msg.tabs) store.setSession("tabs", msg.tabs)
          if (msg.activeTabId !== undefined) store.setSession("activeTabId", msg.activeTabId)
          break
        }
        case "tab.created": {
          store.setSession("tabs", [...store.session.tabs, msg.tab])
          if (msg.active) {
            store.setSession("activeTabId", msg.tab.id)
          }
          break
        }
        case "tab.closed": {
          store.setSession(
            "tabs",
            store.session.tabs.filter((t) => t.id !== msg.tabId),
          )
          if (store.session.activeTabId === msg.tabId && store.session.tabs.length > 0) {
            store.setSession("activeTabId", store.session.tabs[0].id)
          }
          break
        }
        case "tab.navigated": {
          store.setTabUrl(msg.tabId, msg.url)
          store.setTabLoading(msg.tabId, false)
          if (msg.title !== undefined) store.setTabTitle(msg.tabId, msg.title)
          break
        }
        case "screenshot": {
          store.setTabScreenshots(msg.tabId, {
            url: msg.dataUrl,
            width: msg.width ?? 0,
            height: msg.height ?? 0,
          })
          break
        }
        case "console": {
          const current = store.consoleEntries[msg.tabId] ?? []
          store.setConsoleEntries(msg.tabId, [...current, ...msg.entries])
          break
        }
        case "network": {
          const requests = store.networkRequests[msg.tabId] ?? []
          store.setNetworkRequests(msg.tabId, [...requests, ...msg.requests])
          break
        }
        case "agent.action": {
          store.setAgentActivity(msg.action)
          break
        }
        case "error": {
          store.setSession("connectionStatus", "error")
          console.error("Browser WS error:", msg.message)
          break
        }
      }
    })

    socket.addEventListener("error", () => {
      // Handled by close event
    })

    socket.addEventListener("close", () => {
      store.setSession("connectionStatus", "disconnected")
      ws = undefined
      if (disposed) return
      reconnectAttempts++
      if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) return
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY)
    })
  }

  onMount(() => {
    connect()
  })

  onCleanup(() => {
    disposed = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    ws?.close()
    ws = undefined
  })

  return { send }
}
