import { onCleanup, onMount } from "solid-js"
import { useSDK } from "@/context/sdk"
import type { BrowserStoreAPI } from "./browser-store"

const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_DELAY = 2000
const MAX_PENDING_MESSAGES = 50

type BrowserSocket = {
  readyState: number
  send(data: string): void
}

export function createQueuedBrowserSender(
  getSocket: () => BrowserSocket | undefined,
  options: { openState?: number; maxPending?: number } = {},
) {
  const openState = options.openState ?? WebSocket.OPEN
  const maxPending = options.maxPending ?? MAX_PENDING_MESSAGES
  const pending: Record<string, unknown>[] = []

  function send(msg: Record<string, unknown>) {
    const socket = getSocket()
    if (socket?.readyState === openState) {
      socket.send(JSON.stringify(msg))
      return
    }

    pending.push(msg)
    if (pending.length > maxPending) pending.shift()
  }

  function flush() {
    const socket = getSocket()
    if (socket?.readyState !== openState) return
    const messages = pending.splice(0)
    for (const msg of messages) {
      socket.send(JSON.stringify(msg))
    }
  }

  function clear() {
    pending.length = 0
  }

  function size() {
    return pending.length
  }

  return { send, flush, clear, size }
}

export function createBrowserWebSocket(store: BrowserStoreAPI, sessionID: string) {
  const sdk = useSDK()
  let ws: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let reconnectAttempts = 0
  const queued = createQueuedBrowserSender(() => ws)
  const send = queued.send

  store._setSend(send)

  const connect = () => {
    if (disposed) return
    if (!sdk.directory) return
    store.setSession("connectionStatus", "connecting")
    const wsUrl =
      sdk.url.replace(/^http/, "ws") +
      `/${encodeURIComponent(sdk.directory)}/browser/connect?mode=session&sessionID=${encodeURIComponent(sessionID)}`
    const socket = new WebSocket(wsUrl)
    ws = socket

    socket.addEventListener("open", () => {
      reconnectAttempts = 0
      store.setSession("connectionStatus", "connected")
      queued.flush()
    })

    socket.addEventListener("message", (event) => {
      let msg: any
      try {
        msg = JSON.parse(event.data)
      } catch (e) {
        console.warn("Invalid browser WS message", String(e))
        return
      }

      switch (msg.type) {
        case "session.state": {
          if (msg.tabs) store.setSession("tabs", msg.tabs)
          if (msg.activeTabId !== undefined) {
            store.setSession("activeTabId", msg.activeTabId)
            if (!store.session.visibleTabId) store.setSession("visibleTabId", msg.activeTabId)
            if (msg.activeTabId) send({ type: "stream.start", tabId: msg.activeTabId })
          }
          break
        }
        case "tab.created": {
          store.upsertTab(msg.tab)
          if (msg.active) store.activateTabFromServer(msg.tab.id)
          break
        }
        case "tab.updated": {
          if (msg.tab) store.upsertTab(msg.tab)
          break
        }
        case "tab.activated": {
          if (msg.tab) store.upsertTab(msg.tab)
          if (msg.tabId) store.activateTabFromServer(msg.tabId)
          break
        }
        case "tab.closed": {
          store.removeTab(msg.tabId)
          break
        }
        case "tab.navigated": {
          store.setTabUrl(msg.tabId, msg.url)
          store.setTabLoading(msg.tabId, false)
          if (msg.title !== undefined) store.setTabTitle(msg.tabId, msg.title)
          break
        }
        case "page.loading": {
          store.setTabLoading(msg.tabId, true)
          if (msg.url) store.setTabUrl(msg.tabId, msg.url)
          break
        }
        case "page.loaded": {
          store.setTabLoading(msg.tabId, false)
          if (msg.url) store.setTabUrl(msg.tabId, msg.url)
          if (msg.title !== undefined) store.setTabTitle(msg.tabId, msg.title)
          break
        }
        case "page.error": {
          store.setTabLoading(msg.tabId, false)
          store.setBrowserError({ severity: "error", message: msg.message ?? "Browser page error" })
          break
        }
        case "frame": {
          store.setFrame(msg.tabId, {
            src: `data:${msg.mime ?? "image/jpeg"};base64,${msg.data}`,
            metadata: msg.metadata,
          })
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
        case "console":
        case "console.entries": {
          store.setConsoleEntries(msg.tabId, msg.entries ?? [])
          break
        }
        case "network":
        case "network.entries": {
          store.setNetworkRequests(msg.tabId, msg.requests ?? [])
          break
        }
        case "snapshot.result": {
          store.setElements(msg.tabId, msg.elements ?? [])
          break
        }
        case "assets.entries": {
          store.setPageAssets(msg.tabId, msg.assets ?? [])
          break
        }
        case "diagnostics.cleared": {
          store.setConsoleEntries(msg.tabId, [])
          store.setNetworkRequests(msg.tabId, [])
          store.setPageAssets(msg.tabId, [])
          break
        }
        case "agent.action":
        case "agent.activity": {
          store.applyAgentActivity({
            tabId: msg.tabId ?? null,
            url: msg.url ?? null,
            title: msg.title,
            kind: msg.kind ?? "acting",
            tool: msg.tool,
            label: msg.label ?? msg.action ?? null,
          })
          break
        }
        case "control.changed": {
          store.setSession("controlMode", msg.mode)
          break
        }
        case "downloads.updated": {
          store.addDownload(msg.tabId, msg.entry)
          break
        }
        case "filechooser.request": {
          store.setFileChooserRequest({
            tabId: msg.tabId,
            requestId: msg.requestId,
            multiple: Boolean(msg.multiple),
            accept: msg.accept ?? [],
          })
          break
        }
        case "dialog.opened": {
          store.setDialogRequest({
            tabId: msg.tabId,
            requestId: msg.requestId,
            type: msg.dialogType,
            message: msg.message,
            defaultValue: msg.defaultValue,
          })
          break
        }
        case "error": {
          store.setSession("connectionStatus", "error")
          store.setBrowserError({
            severity: msg.severity ?? "error",
            code: msg.code,
            message: msg.message ?? "Browser operation failed",
          })
          console.error("Browser WS error:", msg.message)
          break
        }
      }
    })

    socket.addEventListener("error", () => {
      // Handled by close event.
    })

    socket.addEventListener("close", () => {
      store.setSession("connectionStatus", "disconnected")
      ws = undefined
      if (disposed) return
      reconnectAttempts++
      if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        store.setSession("connectionStatus", "failed")
        return
      }
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY * Math.min(4, reconnectAttempts))
    })
  }

  onMount(() => {
    connect()
  })

  onCleanup(() => {
    disposed = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    queued.clear()
    ws?.close()
    ws = undefined
  })

  return { send, connect }
}
