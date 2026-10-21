import { onCleanup, onMount } from "solid-js"
import {
  BROWSER_HOST_INSTALL_TIMEOUT_MS,
  BROWSER_HOST_START_TIMEOUT_MS,
  BROWSER_PROTOCOL_VERSION,
  BrowserEventSchema,
  type BrowserAPISessionState,
  type BrowserHostStatus,
  type BrowserControlRequest,
} from "@ericsanchezok/synergy-browser-core"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import type { BrowserStoreAPI } from "./browser-store"
import { browserControlCommandFromMessage, createBrowserCommandId } from "./browser-command"
import { browserDebug, shouldLogBrowserMessage, summarizeBrowserMessage } from "./browser-debug"
import { normalizeBrowserError } from "./browser-error"
import { NativePresentationCoordinator, type BrowserClientPresentationMode } from "./native-presentation-coordinator"

const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_DELAY = 2000
const HOST_RETRY_INTERVAL_MS = 1_000

type BrowserWebSocketOptions = {
  sessionID?: string
  mode?: "scope" | "session"
  ownerKey: string
  routeDirectory?: string
  presentation: BrowserClientPresentationMode
  scopeID?: string
  serverUrl?: string
  client?: ReturnType<typeof useSDK>["client"]
}

import { createBrowserEventsWebSocketUrl, type BrowserWebSocketUrlOptions } from "./browser-route-url"
export { createBrowserEventsWebSocketUrl } from "./browser-route-url"

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
  applySnapshot: (snapshot: BrowserAPISessionState, requestEpoch: string | null) => void,
  createNativeTicket?: () => Promise<string>,
) {
  const controllers = new Set<AbortController>()
  const send = (msg: Record<string, unknown>) => {
    const command = browserControlCommandFromMessage(msg)
    if (!command && msg.type !== "page.open") return
    const controller = new AbortController()
    controllers.add(controller)
    const pageId = typeof msg.pageId === "string" ? msg.pageId : undefined
    return (async () => {
      const route = {
        path_directory: options.routeDirectory ?? options.directory ?? options.scopeID ?? options.scopeKey ?? "",
        query_directory: options.directory,
        scopeID: options.scopeID,
        mode: options.mode ?? (options.sessionID ? ("session" as const) : ("scope" as const)),
        sessionID: options.sessionID,
        presentation: "native" as const,
        nativeTicket: await createNativeTicket?.(),
      }
      if (msg.type === "page.open") {
        const response = await options.client.browser.openPage(
          {
            ...route,
            browserOpenPage: {
              requestId: typeof msg.commandId === "string" ? msg.commandId : createBrowserCommandId(),
              url: String(msg.url ?? "about:blank"),
              ...(typeof msg.profileId === "string" ? { profileId: msg.profileId } : {}),
            },
          },
          { signal: controller.signal, throwOnError: true },
        )
        if (!response.data || controller.signal.aborted) return
        const openedId = response.data.id
        if (!store.session.pages.some((page) => page.id === openedId)) {
          const epoch = store.session.epoch
          const state = await options.client.browser.session(
            { ...route, presentation: "auto", protocolVersion: BROWSER_PROTOCOL_VERSION },
            { signal: controller.signal, throwOnError: true },
          )
          if (state.data && !controller.signal.aborted) applySnapshot(state.data, epoch)
        }
        return store.session.pages.find((page) => page.id === openedId)
      }
      if (!pageId) return
      await options.client.browser.control(
        {
          ...route,
          browserControlRequest: {
            protocolVersion: BROWSER_PROTOCOL_VERSION,
            pageId,
            command,
            commandId: typeof msg.commandId === "string" ? msg.commandId : createBrowserCommandId(),
            traceId: options.traceId,
          } as BrowserControlRequest,
        },
        { signal: controller.signal, throwOnError: true },
      )
      if (command?.type === "close") store.removePage(pageId)
    })()
      .catch((error) => {
        const failure = normalizeBrowserError(error, "Browser command failed")
        store.setBrowserError({ pageId, severity: "error", code: failure.code, message: failure.message })
      })
      .finally(() => controllers.delete(controller))
  }
  return {
    send,
    retryNow: () => undefined,
    dispose: () => {
      for (const controller of controllers) controller.abort()
      controllers.clear()
    },
  }
}

export function createBrowserWebSocket(store: BrowserStoreAPI, options: BrowserWebSocketOptions) {
  const sdk = useSDK()
  const platform = usePlatform()
  const sessionID = options.sessionID
  const routeDirectory = options.routeDirectory
  const serverUrl = options.serverUrl ?? sdk.url
  const client = options.client ?? sdk.client
  const scopeID = options.scopeID ?? sdk.scopeID
  let ws: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let reconnectAttempts = 0
  const nativeCoordinator =
    options.presentation === "native" && platform.browserNative
      ? new NativePresentationCoordinator({
          bridge: platform.browserNative,
          serverUrl,
          ownerKey: options.ownerKey,
          onState(state) {
            for (const page of store.session.pages) {
              if (page.status !== "active") continue
              store.setHostStatus(
                page.id,
                state.phase === "ready" ? "ready" : state.phase === "failed" ? "failed" : "restarting",
              )
            }
            if (state.phase === "ready") {
              store.clearTransientHostError()
              return
            }
            store.setBrowserError({
              severity: state.phase === "failed" ? "error" : "warning",
              code: state.error?.code ?? "browser_native_host_connecting",
              message: state.error?.message ?? "The Desktop native Browser is recovering.",
            })
          },
        })
      : null
  const createNativeTicket = () => {
    if (!nativeCoordinator) {
      throw new Error("The Desktop native Browser bridge is unavailable.")
    }
    return nativeCoordinator.createTicket()
  }
  // HTTP snapshots cover page metadata, not pending dialogs or the event replay cursor.
  let catalogSnapshot = { epoch: store.session.epoch, seq: store.session.seq }
  const applySnapshot = (snapshot: BrowserAPISessionState, requestEpoch: string | null) => {
    if (disposed || snapshot.ownerKey !== options.ownerKey) return
    if (requestEpoch !== store.session.epoch && snapshot.epoch !== store.session.epoch) return
    if (store.session.epoch && snapshot.epoch !== store.session.epoch) return
    if (snapshot.epoch === store.session.epoch && snapshot.seq < store.session.seq) return
    if (snapshot.epoch === catalogSnapshot.epoch && snapshot.seq < catalogSnapshot.seq) return
    catalogSnapshot = { epoch: snapshot.epoch, seq: snapshot.seq }
    store.replacePages(snapshot.pages)
    store.replaceAgentActivities(snapshot.agentActivities ?? [])
    for (const page of snapshot.pages)
      store.setHostStatus(page.id, page.status === "active" ? snapshot.hostStatus : "detached")
  }
  const controlSender = createBrowserHttpControlSender(
    store,
    {
      client,
      serverUrl,
      sessionID,
      mode: options.mode,
      routeDirectory,
      directory: sdk.directory,
      scopeID,
      scopeKey: sdk.scopeKey,
      traceId: store.browserTraceId(),
      presentation: options.presentation,
    },
    applySnapshot,
    options.presentation === "native" ? createNativeTicket : undefined,
  )
  const send = controlSender.send

  store._setSend(send)
  const scheduleReconnect = () => {
    if (disposed || reconnectTimer) return
    const reconnectDelay =
      options.presentation === "native" && reconnectAttempts > MAX_RECONNECT_ATTEMPTS
        ? 30_000
        : RECONNECT_DELAY * Math.min(4, reconnectAttempts)
    browserDebug("ws.reconnect.schedule", {
      sessionID,
      reconnectAttempts,
      delay: reconnectDelay,
    })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, reconnectDelay)
  }

  const connect = async () => {
    if (disposed) {
      browserDebug("ws.connect.skipped", { reason: "disposed" })
      return
    }
    let nativeTicket: string | undefined
    try {
      nativeTicket = options.presentation === "native" ? await createNativeTicket() : undefined
    } catch (error) {
      if (disposed) return
      const normalized = normalizeBrowserError(error, "Native Browser presentation failed")
      store.setSession("connectionStatus", "failed")
      store.setBrowserError({ severity: "error", code: normalized.code, message: normalized.message })
      // A failed ticket attempt never opened a socket, so the close handler
      // will not fire. Schedule the reconnect here so the session can recover
      // once the native Host is ready again.
      reconnectAttempts++
      scheduleReconnect()
      return
    }
    if (disposed) return
    const wsUrl = createBrowserEventsWebSocketUrl({
      serverUrl,
      sessionID,
      mode: options.mode,
      routeDirectory,
      directory: sdk.directory,
      scopeID,
      scopeKey: sdk.scopeKey,
      traceId: store.browserTraceId(),
      sinceSeq: store.session.seq,
      epoch: store.session.epoch,
      presentation: options.presentation,
      nativeTicket,
    })
    if (!wsUrl) {
      browserDebug("ws.connect.skipped", {
        reason: "missing scope",
        sessionID,
        routeDirectory,
        directory: sdk.directory,
        scopeID,
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
      scopeID,
      scopeKey: sdk.scopeKey,
    })
    const socket = new WebSocket(wsUrl)
    ws = socket

    socket.addEventListener("open", () => {
      if (disposed || ws !== socket) return
      reconnectAttempts = 0
      store.setSession("connectionStatus", "connected")
      browserDebug("ws.open", { sessionID })
    })

    socket.addEventListener("message", (event) => {
      if (disposed || ws !== socket) return
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
        browserDebug("ws.message.invalid", { error: "Browser event failed protocol validation." })
        socket.close(1003, "Invalid Browser protocol event")
        return
      }
      const msg = parsed.data

      if (shouldLogBrowserMessage(msg)) browserDebug("ws.message", summarizeBrowserMessage(msg))
      if (!acceptSequencedMessage(msg, socket, store)) return
      if (
        "epoch" in msg &&
        msg.epoch === catalogSnapshot.epoch &&
        msg.seq <= catalogSnapshot.seq &&
        [
          "page.created",
          "page.updated",
          "page.closed",
          "page.loading",
          "page.loaded",
          "host.status",
          "agent.activity",
        ].includes(msg.type)
      )
        return
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
          applySnapshot(msg, msg.epoch)
          if (msg.error) {
            store.setSession("connectionStatus", "failed")
            store.setBrowserError({ severity: "error", code: msg.error.code, message: msg.error.message })
          } else {
            store.clearTransientHostError()
          }
          break
        }
        case "host.status": {
          if (isBrowserHostStatus(msg.status)) {
            const ids = msg.pageId
              ? [msg.pageId]
              : store.session.pages.filter((page) => page.status === "active").map((page) => page.id)
            for (const id of ids) store.setHostStatus(id, msg.status)
            if (!msg.pageId && msg.status === "ready") {
              for (const page of store.session.pages) {
                if (page.status === "suspended" && store.hostStatuses[page.id] === "restarting")
                  store.setHostStatus(page.id, "detached")
              }
            }
            if (msg.status === "ready") controlSender.retryNow()
          }
          break
        }
        case "page.created": {
          store.setSession("connectionStatus", "connected")
          store.clearPageError(msg.page.id)
          store.upsertPage(msg.page)
          store.setHostStatus(msg.page.id, "ready")
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
          const navigation = store.session.pages.find((page) => page.id === msg.pageId)?.navigation
          if (
            msg.navigation &&
            navigation &&
            (msg.navigation.generation !== navigation.generation ||
              msg.navigation.id !== navigation.id ||
              navigation.phase !== "failed")
          )
            break
          if (msg.epoch !== catalogSnapshot.epoch || msg.seq > catalogSnapshot.seq)
            store.setPageLoading(msg.pageId, false)
          store.setBrowserError({
            pageId: msg.pageId,
            severity: "error",
            message: msg.message ?? "Browser page error",
            navigation: msg.navigation,
            code: msg.navigation?.error?.code,
          })
          break
        }
        case "agent.activity": {
          store.applyAgentActivity({
            sessionID: msg.sessionID,
            operationID: msg.operationID,
            pageId: msg.pageId,
            url: msg.url,
            title: msg.title,
            kind: msg.kind,
            tool: msg.tool,
            label: msg.label,
            completed: msg.completed,
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
      if (disposed || ws !== socket) return
      // Handled by close event.
      browserDebug("ws.error", { sessionID, eventType: event.type })
    })

    socket.addEventListener("close", (event) => {
      if (disposed || ws !== socket) return
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
      if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS && options.presentation !== "native") {
        store.setSession("connectionStatus", "failed")
        browserDebug("ws.reconnect.failed", { sessionID, reconnectAttempts })
        return
      }
      if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        store.setSession("connectionStatus", "failed")
        store.setBrowserError({
          severity: "error",
          code: "browser_native_ticket_rejected",
          message: "Native Browser presentation is still recovering.",
        })
      }
      scheduleReconnect()
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
    controlSender.dispose()
    nativeCoordinator?.dispose()
    ws?.close()
    ws = undefined
  })

  return {
    send,
    applySnapshot,
    createNativeTicket,
    connect,
    reconnect: () => {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      const previous = ws
      ws = undefined
      previous?.close()
      reconnectAttempts = 0
      void connect()
    },
    retryNative: () => {
      nativeCoordinator?.retry()
      // The coordinator reset alone cannot recover a session whose socket was
      // never opened (non-retryable ticket failure). Reconnect immediately.
      if (!ws || (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING)) {
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = null
        void connect()
      }
    },
  }
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
  if (message.epoch === currentEpoch && message.seq <= store.session.seq) return false
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
