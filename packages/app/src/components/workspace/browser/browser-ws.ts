import { onCleanup, onMount } from "solid-js"
import type { BrowserPresentationPreference } from "@ericsanchezok/synergy-util/browser-protocol"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import type { BrowserHostStatus, BrowserStoreAPI } from "./browser-store"
import { applyBrowserControlResult, browserControlCommandFromMessage, createBrowserCommandId } from "./browser-command"
import { browserDebug, shouldLogBrowserMessage, summarizeBrowserMessage } from "./browser-debug"

const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_DELAY = 2000

type BrowserWebSocketOptions = {
  sessionID: string
  routeDirectory?: string
  client?: "web" | "desktop"
  sameHost?: boolean
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
  traceId?: string
}

export function createBrowserEventsWebSocketUrl(options: BrowserWebSocketUrlOptions) {
  return createBrowserRouteUrl(options, "events", "ws")
}

export function createBrowserControlUrl(options: BrowserWebSocketUrlOptions) {
  return createBrowserRouteUrl(options, "control", "http")
}

function createBrowserRouteUrl(
  options: BrowserWebSocketUrlOptions,
  route: "events" | "control",
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
  if (options.traceId) params.set("traceId", options.traceId)

  const baseUrl = scheme === "ws" ? options.serverUrl.replace(/^http/, "ws") : options.serverUrl
  return baseUrl + `/${encodeURIComponent(pathDirectory)}/browser/${route}?${params.toString()}`
}

function isBrowserHostStatus(value: unknown): value is BrowserHostStatus {
  return (
    value === "pending" || value === "ready" || value === "detached" || value === "restarting" || value === "failed"
  )
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
    const traceId = options.traceId
    const commandId = typeof msg.commandId === "string" ? msg.commandId : createBrowserCommandId()
    void request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(traceId ? { "x-synergy-browser-trace": traceId } : {}),
      },
      body: JSON.stringify({ command, commandId, traceId }),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null)
        if (!response.ok) {
          if (response.status === 409 && payload?.code === "browser_host_pending") {
            if (typeof payload.pageId === "string") store.setHostStatus(payload.pageId, "pending")
            browserDebug("control.pending", {
              type: msg.type,
              pageId: payload?.pageId,
              commandId: payload?.commandId,
              traceId: payload?.traceId,
            })
            return
          }
          throw new Error(payload?.message ?? `Browser control failed: ${response.status}`)
        }
        if (payload?.hostStatus && "pageId" in command && typeof command.pageId === "string") {
          store.setHostStatus(command.pageId, payload.hostStatus)
        }
        store.clearTransientHostError()
        applyBrowserControlResult(store, payload?.result)
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
  let ws: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let reconnectAttempts = 0
  const controlSender = createBrowserHttpControlSender(store, {
    serverUrl: sdk.url,
    sessionID,
    routeDirectory,
    directory: sdk.directory,
    scopeID: sdk.scopeID,
    scopeKey: sdk.scopeKey,
    client,
    sameHost,
    traceId: store.browserTraceId(),
    fetch: platform.fetch,
  })
  const send = controlSender.send

  store._setSend(send)

  const connect = () => {
    if (disposed) {
      browserDebug("ws.connect.skipped", { reason: "disposed" })
      return
    }
    const wsUrl = createBrowserEventsWebSocketUrl({
      serverUrl: sdk.url,
      sessionID,
      routeDirectory,
      directory: sdk.directory,
      scopeID: sdk.scopeID,
      scopeKey: sdk.scopeKey,
      client,
      sameHost,
      traceId: store.browserTraceId(),
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
      directory: sdk.directory,
      scopeID: sdk.scopeID,
      scopeKey: sdk.scopeKey,
    })
    const socket = new WebSocket(wsUrl)
    ws = socket

    socket.addEventListener("open", () => {
      reconnectAttempts = 0
      store.setSession("connectionStatus", "connected")
      browserDebug("ws.open", { sessionID })
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
          if ("page" in msg) store.setSession("page", msg.page ?? null)
          store.clearTransientHostError()
          break
        }
        case "browser.host.status": {
          if (typeof msg.pageId === "string" && isBrowserHostStatus(msg.status)) {
            store.setHostStatus(msg.pageId, msg.status)
          }
          break
        }
        case "page.created": {
          store.upsertPage(msg.page)
          break
        }
        case "page.updated": {
          if (msg.page) store.upsertPage(msg.page)
          break
        }
        case "page.closed": {
          store.removePage(msg.pageId)
          break
        }
        case "page.loading": {
          store.setPageLoading(msg.pageId, true)
          if (msg.url) store.setPageUrl(msg.pageId, msg.url)
          break
        }
        case "page.loaded": {
          store.setPageLoading(msg.pageId, false)
          if (msg.url) store.setPageUrl(msg.pageId, msg.url)
          if (msg.title !== undefined) store.setPageTitle(msg.pageId, msg.title)
          break
        }
        case "page.error": {
          store.setPageLoading(msg.pageId, false)
          store.setBrowserError({ severity: "error", message: msg.message ?? "Browser page error" })
          break
        }
        case "screenshot": {
          store.setPageScreenshots(msg.pageId, {
            url: msg.dataUrl,
            width: msg.width ?? 0,
            height: msg.height ?? 0,
          })
          break
        }
        case "console.entries": {
          store.setConsoleEntries(msg.pageId, msg.entries ?? [])
          break
        }
        case "network.entries": {
          store.setNetworkRequests(msg.pageId, msg.requests ?? [])
          break
        }
        case "snapshot.result": {
          store.setElements(msg.pageId, msg.elements ?? [])
          break
        }
        case "assets.entries": {
          store.setPageAssets(msg.pageId, msg.assets ?? [])
          break
        }
        case "diagnostics.cleared": {
          store.setConsoleEntries(msg.pageId, [])
          store.setNetworkRequests(msg.pageId, [])
          store.setPageAssets(msg.pageId, [])
          break
        }
        case "agent.action":
        case "agent.activity": {
          store.applyAgentActivity({
            pageId: msg.pageId ?? null,
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
          store.addDownload(msg.pageId, msg.entry)
          break
        }
        case "filechooser.request": {
          store.setFileChooserRequest({
            pageId: msg.pageId,
            requestId: msg.requestId,
            multiple: Boolean(msg.multiple),
            accept: msg.accept ?? [],
          })
          break
        }
        case "dialog.opened": {
          store.setDialogRequest({
            pageId: msg.pageId,
            requestId: msg.requestId,
            type: msg.dialogType,
            message: msg.message,
            defaultValue: msg.defaultValue,
          })
          break
        }
        case "error": {
          store.setSession("connectionStatus", "error")
          if (msg.code === "browser_host_pending" && typeof msg.pageId === "string") {
            store.setHostStatus(msg.pageId, "pending")
            break
          }
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
    browserDebug("ws.cleanup", { sessionID, hasSocket: Boolean(ws) })
    disposed = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    ws?.close()
    ws = undefined
  })

  return { send, connect }
}
