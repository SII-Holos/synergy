import { onCleanup, onMount } from "solid-js"
import { useSDK } from "@/context/sdk"
import type { BrowserStoreAPI } from "./browser-store"
import { browserDebug, summarizeBrowserMessage } from "./browser-debug"

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
      browserDebug("ws.send", summarizeBrowserMessage(msg))
      socket.send(JSON.stringify(msg))
      return
    }

    browserDebug("ws.queue", {
      ...summarizeBrowserMessage(msg),
      readyState: socket?.readyState ?? "missing",
      pendingBefore: pending.length,
    })
    pending.push(msg)
    if (pending.length > maxPending) {
      const dropped = pending.shift()
      browserDebug("ws.queue.drop", summarizeBrowserMessage(dropped ?? {}))
    }
  }

  function flush() {
    const socket = getSocket()
    if (socket?.readyState !== openState) {
      browserDebug("ws.flush.skipped", { readyState: socket?.readyState ?? "missing", pending: pending.length })
      return
    }
    const messages = pending.splice(0)
    browserDebug("ws.flush", { count: messages.length })
    for (const msg of messages) {
      browserDebug("ws.send.queued", summarizeBrowserMessage(msg))
      socket.send(JSON.stringify(msg))
    }
  }

  function clear() {
    browserDebug("ws.queue.clear", { count: pending.length })
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
    if (disposed) {
      browserDebug("ws.connect.skipped", { reason: "disposed" })
      return
    }
    if (!sdk.directory) {
      browserDebug("ws.connect.skipped", { reason: "missing directory", sessionID })
      return
    }
    store.setSession("connectionStatus", "connecting")
    const wsUrl =
      sdk.url.replace(/^http/, "ws") +
      `/${encodeURIComponent(sdk.directory)}/browser/connect?mode=session&sessionID=${encodeURIComponent(sessionID)}`
    browserDebug("ws.connect", { sessionID, url: wsUrl })
    const socket = new WebSocket(wsUrl)
    ws = socket

    socket.addEventListener("open", () => {
      reconnectAttempts = 0
      store.setSession("connectionStatus", "connected")
      browserDebug("ws.open", { sessionID, pending: queued.size() })
      queued.flush()
    })

    socket.addEventListener("message", (event) => {
      let msg: any
      try {
        msg = JSON.parse(event.data)
      } catch (e) {
        console.warn("Invalid browser WS message", String(e))
        browserDebug("ws.message.invalid", { error: String(e), dataLength: String(event.data ?? "").length })
        return
      }

      browserDebug("ws.message", summarizeBrowserMessage(msg))
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
          browserDebug("ws.message.error", summarizeBrowserMessage(msg))
          break
        }
      }
    })

    socket.addEventListener("error", (event) => {
      // Handled by close event.
      browserDebug("ws.error", { sessionID, eventType: event.type })
    })

    socket.addEventListener("close", (event) => {
      store.setSession("connectionStatus", "disconnected")
      ws = undefined
      browserDebug("ws.close", {
        sessionID,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        disposed,
        reconnectAttempts,
      })
      if (disposed) return
      reconnectAttempts++
      if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        store.setSession("connectionStatus", "failed")
        browserDebug("ws.reconnect.failed", { sessionID, reconnectAttempts })
        return
      }
      browserDebug("ws.reconnect.schedule", {
        sessionID,
        reconnectAttempts,
        delay: RECONNECT_DELAY * Math.min(4, reconnectAttempts),
      })
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY * Math.min(4, reconnectAttempts))
    })
  }

  onMount(() => {
    browserDebug("ws.mount", { sessionID })
    connect()
  })

  onCleanup(() => {
    browserDebug("ws.cleanup", { sessionID, hasSocket: Boolean(ws), pending: queued.size() })
    disposed = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    queued.clear()
    ws?.close()
    ws = undefined
  })

  return { send, connect }
}
