import { onCleanup, onMount } from "solid-js"
import type { BrowserPresentationPreference } from "@ericsanchezok/synergy-util/browser-protocol"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import type { BrowserStoreAPI } from "./browser-store"
import { browserDebug, shouldLogBrowserMessage, summarizeBrowserMessage } from "./browser-debug"

const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_DELAY = 2000
const MAX_PENDING_MESSAGES = 50
const LEGACY_STREAM_ENV = "VITE_SYNERGY_BROWSER_LEGACY_STREAM"

type BrowserSocket = {
  readyState: number
  send(data: string): void
}

type BrowserWebSocketOptions = {
  sessionID: string
  routeDirectory?: string
  client?: "web" | "desktop"
  sameHost?: boolean
  transport?: BrowserClientTransport
}

type BrowserWebSocketUrlOptions = {
  serverUrl: string
  sessionID: string
  routeDirectory?: string
  directory?: string
  scopeID?: string
  scopeKey?: string
  presentation?: BrowserPresentationPreference
  client?: "web" | "desktop"
  sameHost?: boolean
}

export type BrowserClientTransport = "legacy" | "control"

export function isLegacyBrowserStreamEnabled(env: Record<string, unknown> = import.meta.env): boolean {
  return env[LEGACY_STREAM_ENV] === "1" || env[LEGACY_STREAM_ENV] === "true"
}

export function selectBrowserClientTransport(options: {
  requested?: BrowserClientTransport
  legacyStreamEnabled?: boolean
}): BrowserClientTransport {
  if (options.requested) return options.requested
  return options.legacyStreamEnabled ? "legacy" : "control"
}

export function createBrowserWebSocketUrl(options: BrowserWebSocketUrlOptions) {
  return createBrowserRouteUrl(options, "connect", "ws")
}

export function createBrowserEventsWebSocketUrl(options: BrowserWebSocketUrlOptions) {
  return createBrowserRouteUrl(options, "events", "ws")
}

export function createBrowserControlUrl(options: BrowserWebSocketUrlOptions) {
  return createBrowserRouteUrl(options, "control", "http")
}

function createBrowserRouteUrl(
  options: BrowserWebSocketUrlOptions,
  route: "connect" | "events" | "control",
  scheme: "ws" | "http",
) {
  const pathDirectory = options.routeDirectory ?? options.directory ?? options.scopeID ?? options.scopeKey
  if (!pathDirectory) return null

  const params = new URLSearchParams({
    mode: "session",
    sessionID: options.sessionID,
    presentation: options.presentation ?? "auto",
    client: options.client ?? "web",
  })
  if (options.scopeID) params.set("scopeID", options.scopeID)
  else if (options.directory) params.set("directory", options.directory)
  if (options.sameHost) params.set("sameHost", "1")
  if (route === "connect") params.set("legacyStream", "1")

  const baseUrl = scheme === "ws" ? options.serverUrl.replace(/^http/, "ws") : options.serverUrl
  return baseUrl + `/${encodeURIComponent(pathDirectory)}/browser/${route}?${params.toString()}`
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
      if (shouldLogBrowserMessage(msg)) browserDebug("ws.send", summarizeBrowserMessage(msg))
      socket.send(JSON.stringify(msg))
      return
    }

    if (shouldLogBrowserMessage(msg)) {
      browserDebug("ws.queue", {
        ...summarizeBrowserMessage(msg),
        readyState: socket?.readyState ?? "missing",
        pendingBefore: pending.length,
      })
    }
    pending.push(msg)
    if (pending.length > maxPending) {
      const dropped = pending.shift()
      if (dropped && shouldLogBrowserMessage(dropped)) browserDebug("ws.queue.drop", summarizeBrowserMessage(dropped))
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
      if (shouldLogBrowserMessage(msg)) browserDebug("ws.send.queued", summarizeBrowserMessage(msg))
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

export function browserControlCommandFromMessage(msg: Record<string, unknown>): Record<string, unknown> | null {
  switch (msg.type) {
    case "navigate":
      return { type: "navigate", source: "user", tabId: msg.tabId, url: String(msg.url ?? "") }
    case "reload":
      return { type: "reload", tabId: msg.tabId }
    case "stop":
      return { type: "stop", tabId: msg.tabId }
    case "history":
      if (msg.direction !== "back" && msg.direction !== "forward") return null
      return { type: "history", tabId: msg.tabId, direction: msg.direction }
    case "createTab":
      return typeof msg.url === "string" ? { type: "createTab", url: msg.url } : { type: "createTab" }
    case "closeTab":
      return { type: "closeTab", tabId: String(msg.tabId ?? "") }
    case "switchTab":
      return { type: "switchTab", tabId: String(msg.tabId ?? "") }
    case "input.resize":
      return {
        type: "setViewport",
        tabId: msg.tabId,
        width: Number(msg.width),
        height: Number(msg.height),
        deviceScaleFactor: Number(msg.deviceScaleFactor ?? 1),
      }
    case "input.mouse":
      if (msg.action !== "move" && msg.action !== "down" && msg.action !== "up" && msg.action !== "wheel") return null
      return { type: "mouse", tabId: msg.tabId, action: msg.action, input: msg }
    case "input.key":
      if (msg.action !== "down" && msg.action !== "up") return null
      return { type: "key", tabId: msg.tabId, action: msg.action, input: msg }
    case "input.text":
      return { type: "insertText", tabId: msg.tabId, text: String(msg.text ?? "") }
    case "requestConsole":
      return { type: "console", tabId: msg.tabId, maxEntries: msg.maxEntries }
    case "requestNetwork":
      return { type: "network", tabId: msg.tabId, maxEntries: msg.maxEntries }
    case "requestSnapshot":
      return { type: "snapshot", tabId: msg.tabId }
    case "requestAssets":
      return { type: "assets", tabId: msg.tabId, maxEntries: msg.maxEntries }
    case "requestScreenshot":
      return { type: "screenshot", tabId: msg.tabId }
    case "filechooser.select":
      return {
        type: "filechooser.select",
        tabId: msg.tabId,
        requestId: String(msg.requestId ?? ""),
        files: msg.files ?? [],
      }
    case "dialog.respond":
      return {
        type: "dialog.respond",
        tabId: msg.tabId,
        requestId: String(msg.requestId ?? ""),
        accept: Boolean(msg.accept),
        promptText: msg.promptText,
      }
    case "createAnnotation":
      return {
        type: "createAnnotation",
        tabId: msg.tabId,
        comment: String(msg.comment ?? ""),
        styleFeedback: msg.styleFeedback,
      }
    case "clearLogs":
      return { type: "clearDiagnostics", tabId: msg.tabId }
    case "setFollowAgent":
    case "followAgentNow":
    case "stream.start":
    case "stream.stop":
      return null
    default:
      return null
  }
}

function applyControlResult(store: BrowserStoreAPI, result: any) {
  switch (result?.type) {
    case "tab":
      store.upsertTab(result.tab)
      break
    case "navigation":
      store.upsertTab(result.tab)
      store.setTabLoading(result.tab.id, false)
      break
    case "session":
      store.setSession("tabs", result.session?.tabs ?? [])
      store.setSession("activeTabId", result.session?.activeTabId ?? null)
      if (!store.session.visibleTabId) store.setSession("visibleTabId", result.session?.activeTabId ?? null)
      break
    case "console":
      store.setConsoleEntries(result.tabId, result.entries ?? [])
      break
    case "network":
      store.setNetworkRequests(result.tabId, result.requests ?? [])
      break
    case "snapshot":
      store.setElements(result.tabId, result.elements ?? [])
      break
    case "assets":
      store.setPageAssets(result.tabId, result.assets ?? [])
      break
    case "screenshot":
      store.setTabScreenshots(result.tabId, {
        url: result.dataUrl,
        width: result.width ?? 0,
        height: result.height ?? 0,
      })
      break
    case "diagnostics.cleared":
      store.setConsoleEntries(result.tabId, [])
      store.setNetworkRequests(result.tabId, [])
      store.setPageAssets(result.tabId, [])
      break
  }
}

function createBrowserHttpControlSender(
  store: BrowserStoreAPI,
  options: BrowserWebSocketUrlOptions & { fetch?: typeof fetch },
) {
  const send = (msg: Record<string, unknown>) => {
    const command = browserControlCommandFromMessage(msg)
    if (!command) {
      if (shouldLogBrowserMessage(msg)) browserDebug("control.skip", summarizeBrowserMessage(msg))
      return
    }
    const url = createBrowserControlUrl(options)
    if (!url) {
      browserDebug("control.dropped", { reason: "missing scope", type: msg.type })
      return
    }
    if (shouldLogBrowserMessage(msg)) browserDebug("control.send", summarizeBrowserMessage(msg))
    const request = options.fetch ?? fetch
    void request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command }),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null)
        if (!response.ok) {
          throw new Error(payload?.message ?? `Browser control failed: ${response.status}`)
        }
        applyControlResult(store, payload?.result)
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        browserDebug("control.error", { type: msg.type, message })
        store.setBrowserError({ severity: "error", message })
      })
  }

  return { send }
}

export function createBrowserWebSocket(store: BrowserStoreAPI, options: BrowserWebSocketOptions | string) {
  const sdk = useSDK()
  const platform = usePlatform()
  const sessionID = typeof options === "string" ? options : options.sessionID
  const routeDirectory = typeof options === "string" ? undefined : options.routeDirectory
  const client = typeof options === "string" ? "web" : (options.client ?? "web")
  const sameHost = typeof options === "string" ? false : (options.sameHost ?? false)
  const transport = selectBrowserClientTransport({
    requested: typeof options === "string" ? undefined : options.transport,
    legacyStreamEnabled: isLegacyBrowserStreamEnabled(),
  })
  let ws: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let reconnectAttempts = 0
  const queued = createQueuedBrowserSender(() => ws)
  const controlSender = createBrowserHttpControlSender(store, {
    serverUrl: sdk.url,
    sessionID,
    routeDirectory,
    directory: sdk.directory,
    scopeID: sdk.scopeID,
    scopeKey: sdk.scopeKey,
    client,
    sameHost,
    fetch: platform.fetch,
  })
  const send = transport === "control" ? controlSender.send : queued.send

  store._setSend(send)

  const connect = () => {
    if (disposed) {
      browserDebug("ws.connect.skipped", { reason: "disposed" })
      return
    }
    const createUrl = transport === "control" ? createBrowserEventsWebSocketUrl : createBrowserWebSocketUrl
    const wsUrl = createUrl({
      serverUrl: sdk.url,
      sessionID,
      routeDirectory,
      directory: sdk.directory,
      scopeID: sdk.scopeID,
      scopeKey: sdk.scopeKey,
      client,
      sameHost,
    })
    if (!wsUrl) {
      browserDebug("ws.connect.skipped", {
        reason: "missing scope",
        sessionID,
        routeDirectory,
        directory: sdk.directory,
        scopeID: sdk.scopeID,
        scopeKey: sdk.scopeKey,
      })
      return
    }
    store.setSession("connectionStatus", "connecting")
    browserDebug("ws.connect", {
      sessionID,
      url: wsUrl,
      routeDirectory,
      transport,
      directory: sdk.directory,
      scopeID: sdk.scopeID,
      scopeKey: sdk.scopeKey,
    })
    const socket = new WebSocket(wsUrl)
    ws = socket

    socket.addEventListener("open", () => {
      reconnectAttempts = 0
      store.setSession("connectionStatus", "connected")
      browserDebug("ws.open", { sessionID, pending: queued.size() })
      if (transport !== "control") queued.flush()
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

      if (shouldLogBrowserMessage(msg)) browserDebug("ws.message", summarizeBrowserMessage(msg))
      switch (msg.type) {
        case "session.state": {
          if (msg.presentation) store.setPresentation(msg.presentation)
          if (msg.tabs) store.setSession("tabs", msg.tabs)
          if (msg.activeTabId !== undefined) {
            store.setSession("activeTabId", msg.activeTabId)
            if (!store.session.visibleTabId) store.setSession("visibleTabId", msg.activeTabId)
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
    if (transport !== "control") queued.clear()
    ws?.close()
    ws = undefined
  })

  return { send, connect }
}
