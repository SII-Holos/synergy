import { onCleanup, onMount } from "solid-js"
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserEventSchema,
  type BrowserHostStatus,
  type BrowserControlRequest,
  type BrowserPresentationPreference,
} from "@ericsanchezok/synergy-browser"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import type { BrowserStoreAPI } from "./browser-store"
import { applyBrowserControlResult, browserControlCommandFromMessage, createBrowserCommandId } from "./browser-command"
import { browserDebug, shouldLogBrowserMessage, summarizeBrowserMessage } from "./browser-debug"
import { normalizeBrowserError } from "./browser-error"

const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_DELAY = 2000

type BrowserWebSocketOptions = {
  sessionID: string
  ownerKey: string
  routeDirectory?: string
}

type BrowserWebSocketUrlOptions = {
  serverUrl: string
  sessionID: string
  routeDirectory?: string
  directory?: string
  scopeID?: string
  scopeKey?: string
  presentation?: BrowserPresentationPreference
  traceId?: string
  sinceSeq?: number
  epoch?: string | null
  nativeTicket?: string
}

export function createBrowserEventsWebSocketUrl(options: BrowserWebSocketUrlOptions) {
  return createBrowserRouteUrl(options, "events", "ws")
}

function createBrowserRouteUrl(options: BrowserWebSocketUrlOptions, route: "events", scheme: "ws") {
  const pathDirectory = options.routeDirectory ?? options.directory ?? options.scopeID ?? options.scopeKey
  if (!pathDirectory) return null

  const params = new URLSearchParams({
    mode: "session",
    sessionID: options.sessionID,
    presentation: options.presentation ?? "auto",
    protocolVersion: String(BROWSER_PROTOCOL_VERSION),
  })
  if (options.scopeID) params.set("scopeID", options.scopeID)
  else if (options.directory) params.set("directory", options.directory)
  if (options.traceId) params.set("traceId", options.traceId)
  if (options.sinceSeq !== undefined) params.set("sinceSeq", String(options.sinceSeq))
  if (options.epoch) params.set("epoch", options.epoch)
  if (options.nativeTicket) params.set("nativeTicket", options.nativeTicket)

  const baseUrl = options.serverUrl.replace(/^http/, "ws")
  return baseUrl + `/${encodeURIComponent(pathDirectory)}/browser/${route}?${params.toString()}`
}

function isBrowserHostStatus(value: unknown): value is BrowserHostStatus {
  return [
    "unavailable",
    "installing",
    "starting",
    "pending",
    "ready",
    "detached",
    "restarting",
    "idle",
    "failed",
  ].includes(String(value))
}

function createBrowserHttpControlSender(
  store: BrowserStoreAPI,
  options: BrowserWebSocketUrlOptions & { client: ReturnType<typeof useSDK>["client"] },
  createNativeTicket?: () => Promise<string | undefined>,
) {
  const send = (msg: Record<string, unknown>) => {
    const command = browserControlCommandFromMessage(msg)
    if (!command) {
      if (shouldLogBrowserMessage(msg)) browserDebug("control.skip", summarizeBrowserMessage(msg))
      return
    }
    const pathDirectory = options.routeDirectory ?? options.directory ?? options.scopeID ?? options.scopeKey
    if (!pathDirectory) {
      browserDebug("control.dropped", { reason: "missing scope", type: msg.type })
      return
    }
    if (shouldLogBrowserMessage(msg)) browserDebug("control.send", summarizeBrowserMessage(msg))
    void (async () => {
      const nativeTicket = await createNativeTicket?.()
      const traceId = options.traceId
      const commandId = typeof msg.commandId === "string" ? msg.commandId : createBrowserCommandId()
      const payload = await options.client.browser.control({
        path_directory: pathDirectory,
        query_directory: options.directory,
        scopeID: options.scopeID,
        mode: "session",
        sessionID: options.sessionID,
        presentation: nativeTicket ? "native" : (options.presentation ?? "auto"),
        nativeTicket,
        browserControlRequest: {
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          command,
          commandId,
          traceId,
        } as BrowserControlRequest,
      })
      if (!payload.data) throw payload.error ?? new Error("Browser control failed")
      store.clearTransientHostError()
      applyBrowserControlResult(store, payload.data.result)
    })().catch((error) => {
      const normalized = normalizeBrowserError(error, "Browser control failed")
      browserDebug("control.error", { type: msg.type, message: normalized.message, code: normalized.code })
      store.setBrowserError({ severity: "error", message: normalized.message, code: normalized.code })
    })
  }

  return { send }
}

export function createBrowserWebSocket(store: BrowserStoreAPI, options: BrowserWebSocketOptions) {
  const sdk = useSDK()
  const platform = usePlatform()
  const sessionID = options.sessionID
  const routeDirectory = options.routeDirectory
  let ws: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let reconnectAttempts = 0
  const createNativeTicket = async () => {
    const bridge = platform.browserNative
    if (!bridge) return undefined
    try {
      return await bridge.createPresentationTicket({
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        serverUrl: sdk.url,
        ownerKey: options.ownerKey,
      })
    } catch {
      return undefined
    }
  }
  const controlSender = createBrowserHttpControlSender(
    store,
    {
      client: sdk.client,
      serverUrl: sdk.url,
      sessionID,
      routeDirectory,
      directory: sdk.directory,
      scopeID: sdk.scopeID,
      scopeKey: sdk.scopeKey,
      traceId: store.browserTraceId(),
    },
    createNativeTicket,
  )
  const send = controlSender.send

  store._setSend(send)

  const connect = async () => {
    if (disposed) {
      browserDebug("ws.connect.skipped", { reason: "disposed" })
      return
    }
    const nativeTicket = await createNativeTicket()
    if (disposed) return
    const wsUrl = createBrowserEventsWebSocketUrl({
      serverUrl: sdk.url,
      sessionID,
      routeDirectory,
      directory: sdk.directory,
      scopeID: sdk.scopeID,
      scopeKey: sdk.scopeKey,
      traceId: store.browserTraceId(),
      sinceSeq: store.session.seq,
      epoch: store.session.epoch,
      presentation: nativeTicket ? "native" : "auto",
      nativeTicket,
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
      let input: unknown
      try {
        input = JSON.parse(event.data)
      } catch (e) {
        console.warn("Invalid browser WS message", String(e))
        browserDebug("ws.message.invalid", { error: String(e), dataLength: String(event.data ?? "").length })
        return
      }
      const parsed = BrowserEventSchema.safeParse(input)
      if (!parsed.success) {
        browserDebug("ws.message.invalid", { error: "Browser event failed Protocol v2 validation." })
        socket.close(1003, "Invalid Browser Protocol v2 event")
        return
      }
      const msg = parsed.data

      if (shouldLogBrowserMessage(msg)) browserDebug("ws.message", summarizeBrowserMessage(msg))
      if (!acceptSequencedMessage(msg, socket, store)) return
      switch (msg.type) {
        case "session.state": {
          if (msg.ownerKey !== options.ownerKey) {
            store.setBrowserError({
              severity: "critical",
              code: "browser_owner_mismatch",
              message: "Browser session owner does not match the active workspace.",
            })
            socket.close(1008, "Browser session owner mismatch")
            return
          }
          store.setPresentation(msg.presentation)
          store.setSession("page", msg.page)
          if (msg.page) store.setHostStatus(msg.page.id, msg.hostStatus)
          if (msg.error) {
            store.setSession("connectionStatus", "failed")
            store.setBrowserError({ severity: "error", code: msg.error.code, message: msg.error.message })
          } else {
            store.clearTransientHostError()
          }
          break
        }
        case "host.status": {
          const pageId = typeof msg.pageId === "string" ? msg.pageId : store.pageId()
          if (pageId && isBrowserHostStatus(msg.status)) {
            store.setHostStatus(pageId, msg.status)
          }
          break
        }
        case "page.created": {
          store.setSession("connectionStatus", "connected")
          store.setBrowserError(null)
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
          if (msg.page) store.upsertPage(msg.page)
          break
        }
        case "page.error": {
          store.setPageLoading(msg.pageId, false)
          store.setBrowserError({ severity: "error", message: msg.message ?? "Browser page error" })
          break
        }
        case "agent.activity": {
          store.applyAgentActivity({
            pageId: msg.pageId,
            url: msg.url,
            title: msg.title,
            kind: msg.kind,
            tool: msg.tool,
            label: msg.label,
          })
          break
        }
        case "control.changed": {
          store.setSession("controlMode", msg.mode)
          break
        }
        case "download.updated": {
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
            severity: "error",
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
      reconnectTimer = setTimeout(() => void connect(), RECONNECT_DELAY * Math.min(4, reconnectAttempts))
    })
  }

  onMount(() => {
    browserDebug("ws.mount", { sessionID })
    void connect()
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

function acceptSequencedMessage(
  message: { type?: unknown; seq?: unknown; epoch?: unknown },
  socket: WebSocket,
  store: BrowserStoreAPI,
): boolean {
  if (typeof message.seq !== "number" || !Number.isInteger(message.seq) || typeof message.epoch !== "string") {
    return true
  }
  const currentEpoch = store.session.epoch
  const isSnapshot = message.type === "session.state"
  if (!currentEpoch || isSnapshot) {
    if (isSnapshot && currentEpoch === message.epoch && message.seq < store.session.seq) return false
    store.setSession({ seq: message.seq, epoch: message.epoch })
    return true
  }
  if (message.epoch !== currentEpoch || message.seq !== store.session.seq + 1) {
    browserDebug("ws.sequence.gap", {
      currentEpoch,
      currentSeq: store.session.seq,
      messageEpoch: message.epoch,
      messageSeq: message.seq,
    })
    socket.close(4002, "Browser event sequence gap")
    return false
  }
  store.setSession({ seq: message.seq, epoch: message.epoch })
  return true
}
