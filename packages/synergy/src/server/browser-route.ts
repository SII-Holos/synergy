import type { BrowserSession } from "../browser/types.js"
import type { BrowserTab } from "../browser/tab.js"
import {
  parseBrowserPresentationPreference,
  type BrowserPresentationSelection,
} from "@ericsanchezok/synergy-util/browser-protocol"
import { Hono } from "hono"
import { upgradeWebSocket } from "hono/bun"
import { Log } from "../util/log"
import { BrowserOwner } from "../browser/owner.js"
import { BrowserControl } from "../browser/control.js"
import { BrowserElectronHostProcess } from "../browser/electron-host-process.js"
import { BrowserHost } from "../browser/host.js"
import { BrowserHostControl, BrowserHostControlNotAttachedError } from "../browser/host-control.js"
import { BrowserWebRTCSignaling } from "../browser/webrtc-signaling.js"
import { ScopeContext } from "../scope/context"

const log = Log.create({ service: "browser.route" })

interface BrowserWS {
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface BrowserRouteContext {
  req: {
    param(name: string): string
    query(name: string): string | undefined
    json(): Promise<unknown>
  }
}

interface BrowserRouteState {
  directory: string
  owner: BrowserOwner.Info
  presentation: BrowserPresentationSelection
  client: "web" | "desktop"
}

interface BrowserControlRequest {
  command: BrowserControl.Command
  commandId?: string
  traceId?: string
}

interface PendingViewportCommand {
  owner: BrowserOwner.Info
  command: Extract<BrowserControl.Command, { type: "setViewport" }>
  commandId?: string
  traceId?: string
  updatedAt: number
}

const pendingViewportCommands = new Map<string, PendingViewportCommand>()

BrowserHostControl.addGlobalObserver((owner, event) => {
  if (event.type !== "browser.host.status") return
  if (event.status !== "ready" || typeof event.tabId !== "string") return
  flushPendingViewport(owner, event.tabId)
})

function tabPayload(tab: BrowserTab) {
  return BrowserControl.tabState(tab)
}

function sessionPayload(
  session: BrowserSession,
  presentation: BrowserPresentationSelection,
  runtimeHealth?: Awaited<ReturnType<typeof BrowserHost.health>>,
) {
  return {
    type: "session.state",
    ...BrowserControl.sessionState(session),
    connection: { status: "connected" },
    presentation,
    runtimeHealth,
  }
}

function sessionStatePayload(
  session: BrowserControl.SessionState,
  presentation: BrowserPresentationSelection,
  runtimeHealth?: Awaited<ReturnType<typeof BrowserHost.health>>,
) {
  return {
    type: "session.state",
    tabs: session.tabs,
    activeTabId: session.activeTabId,
    connection: { status: "connected" },
    presentation,
    runtimeHealth,
  }
}

function send(ws: BrowserWS, payload: Record<string, unknown>) {
  try {
    ws.send(JSON.stringify(payload))
  } catch {
    // The socket may have closed between async browser events.
  }
}

function subscribeBrowserEvents(ws: BrowserWS, session: BrowserSession) {
  return session.addObserver({
    onTabCreated: (tab) => {
      send(ws, { type: "tab.created", tab: tabPayload(tab), active: session.activeTab === tab })
    },
    onTabClosed: (tabId) => {
      send(ws, { type: "tab.closed", tabId })
    },
    onTabUpdated: (tab) => {
      send(ws, { type: "tab.updated", tab: tabPayload(tab) })
    },
    onTabActivated: (tab) => {
      send(ws, { type: "tab.activated", tabId: tab.id, tab: tabPayload(tab) })
    },
    onTabNavigated: (tab) => {
      send(ws, { type: "tab.updated", tab: tabPayload(tab) })
    },
    onPageLoadState: (tab, state, message) => {
      const type = state === "loading" ? "page.loading" : state === "loaded" ? "page.loaded" : "page.error"
      send(ws, { type, tabId: tab.id, url: tab.url, title: tab.title, message })
    },
    onAgentActivity: (activity) => {
      send(ws, { type: "agent.activity", ...activity })
    },
    onControlChanged: (mode) => {
      send(ws, { type: "control.changed", mode })
    },
    onDownload: (tab, entry) => {
      send(ws, { type: "downloads.updated", tabId: tab.id, entry })
    },
    onFileChooser: (tab, request) => {
      send(ws, { type: "filechooser.request", tabId: tab.id, ...request })
    },
    onDialog: (tab, request) => {
      send(ws, {
        type: "dialog.opened",
        tabId: tab.id,
        requestId: request.requestId,
        dialogType: request.type,
        message: request.message,
        defaultValue: request.defaultValue,
      })
    },
  })
}

function isCrossOriginRequest(c: { req: { header(name: string): string | undefined } }) {
  const origin = c.req.header("origin")
  const host = c.req.header("host")
  return Boolean(origin && host && !isSameOrigin(origin, host))
}

function requestOrigin(c: { req: { url: string; header(name: string): string | undefined } }): string {
  try {
    return new URL(c.req.url).origin
  } catch {
    const host = c.req.header("host") ?? "localhost"
    return `http://${host}`
  }
}

function routeState(c: BrowserRouteContext): BrowserRouteState {
  const directory = c.req.param("directory")
  if (!directory) throw new Error("Missing directory")

  const mode = (c.req.query("mode") ?? "session") as BrowserOwner.Mode
  const sessionID = c.req.query("sessionID")
  const client = c.req.query("client") === "desktop" ? "desktop" : "web"
  const sameHostQuery = c.req.query("sameHost")
  const sameHost = sameHostQuery === "1" || sameHostQuery === "true"
  const presentation = BrowserHost.presentation({
    desktop: client === "desktop",
    sameHost,
    remote: client !== "desktop" || !sameHost,
    requested: parseBrowserPresentationPreference(c.req.query("presentation")),
  })
  const owner = BrowserOwner.fromRoute({
    directory: ScopeContext.current.directory,
    scopeID: ScopeContext.current.scope.id,
    sessionID,
    mode,
  })
  BrowserOwner.assertValid(owner)
  return { directory, owner, presentation, client }
}

async function ensureSession(
  owner: BrowserOwner.Info,
  options?: BrowserHost.EnsureSessionOptions,
): Promise<BrowserSession> {
  return BrowserHost.ensureSession(owner, options)
}

async function readControlRequest(c: BrowserRouteContext): Promise<BrowserControlRequest> {
  const body = await c.req.json()
  if (typeof body !== "object" || body === null || !("command" in body)) {
    throw new Error("Invalid browser control command")
  }
  const request = body as { command: unknown; commandId?: unknown; traceId?: unknown }
  const command = request.command
  if (typeof command !== "object" || command === null || typeof (command as { type?: unknown }).type !== "string") {
    throw new Error("Invalid browser control command")
  }
  return {
    command: command as BrowserControl.Command,
    commandId: typeof request.commandId === "string" ? request.commandId : undefined,
    traceId: typeof request.traceId === "string" ? request.traceId : undefined,
  }
}

function traceId(
  c: { req: { header(name: string): string | undefined; query(name: string): string | undefined } },
  bodyTrace?: string,
) {
  return c.req.header("x-synergy-browser-trace") ?? c.req.query("traceId") ?? bodyTrace
}

function commandTabId(owner: BrowserOwner.Info, command: BrowserControl.Command): string | null {
  if ("tabId" in command && typeof command.tabId === "string" && command.tabId) return command.tabId
  return BrowserHostControl.sessionState(owner)?.activeTabId ?? null
}

function pendingViewportKey(owner: BrowserOwner.Info, tabId: string): string {
  return `${BrowserOwner.key(owner)}:tab:${tabId}:viewport`
}

function deferViewport(
  owner: BrowserOwner.Info,
  command: Extract<BrowserControl.Command, { type: "setViewport" }>,
  request: { commandId?: string; traceId?: string },
) {
  const tabId = commandTabId(owner, command)
  if (!tabId) return false
  pendingViewportCommands.set(pendingViewportKey(owner, tabId), {
    owner,
    command: { ...command, tabId },
    commandId: request.commandId,
    traceId: request.traceId,
    updatedAt: Date.now(),
  })
  BrowserHostControl.markStatus(owner, tabId, "pending", {
    traceId: request.traceId,
    reason: "viewport_deferred_until_host_ready",
  })
  log.info("browser.route.control.deferred", {
    ownerKey: BrowserOwner.key(owner),
    tabId,
    commandId: request.commandId,
    commandType: command.type,
    traceId: request.traceId,
    reason: "host_pending",
  })
  return true
}

function flushPendingViewport(owner: BrowserOwner.Info, tabId: string): void {
  const key = pendingViewportKey(owner, tabId)
  const pending = pendingViewportCommands.get(key)
  if (!pending || !BrowserHostControl.isReady(owner, tabId)) return
  pendingViewportCommands.delete(key)
  void BrowserHostControl.execute(pending.owner, pending.command, {
    commandId: pending.commandId,
    traceId: pending.traceId,
  }).catch((error) => {
    log.warn("browser.route.control.failed", {
      ownerKey: BrowserOwner.key(owner),
      tabId,
      commandId: pending.commandId,
      commandType: pending.command.type,
      traceId: pending.traceId,
      error: error instanceof Error ? error.message : String(error),
      deferredAgeMs: Date.now() - pending.updatedAt,
    })
  })
}

function hostPendingPayload(input: {
  command: BrowserControl.Command
  commandId?: string
  traceId?: string
  tabId?: string | null
}) {
  return {
    type: "error",
    code: "browser_host_pending",
    message: "Browser Host is still preparing.",
    retryable: true,
    traceId: input.traceId,
    tabId: input.tabId ?? null,
    commandId: input.commandId,
    commandType: input.command.type,
  }
}

function commandNeedsReadyHost(command: BrowserControl.Command): boolean {
  return command.type !== "createTab" && command.type !== "setViewport" && command.type !== "closeTab"
}

function hostReadyTimeoutMs(): number {
  const configured = Number(process.env.SYNERGY_BROWSER_HOST_READY_TIMEOUT_MS)
  return Number.isFinite(configured) && configured >= 0 ? configured : 5_000
}

async function executeWebRTCCreateTab(
  state: BrowserRouteState,
  command: Extract<BrowserControl.Command, { type: "createTab" }>,
  request: { commandId?: string; traceId?: string },
  serverUrl: string,
) {
  const session = await ensureSession(state.owner)
  const result = await BrowserControl.execute(session, command)
  if (result.type !== "tab") return result

  BrowserHostControl.markStatus(state.owner, result.tab.id, "pending", {
    traceId: request.traceId,
    reason: "tab_created",
  })
  const ensure = BrowserElectronHostProcess.ensure({
    owner: state.owner,
    tabId: result.tab.id,
    serverUrl,
    routeDirectory: state.directory,
    url: result.tab.url,
    traceId: request.traceId,
  })
  log.info("browser.route.control.deferred", {
    ownerKey: BrowserOwner.key(state.owner),
    tabId: result.tab.id,
    commandId: request.commandId,
    commandType: command.type,
    traceId: request.traceId,
    hostProcessKey: ensure.key,
    hostStatus: BrowserHostControl.status(state.owner, result.tab.id),
  })
  return {
    ...result,
    hostStatus: BrowserHostControl.status(state.owner, result.tab.id),
  }
}

export const BrowserRoute = new Hono()
  .get("/:directory/browser/session", async (c) => {
    try {
      const { owner, presentation } = routeState(c)
      const hostSession = BrowserHostControl.sessionState(owner)
      if (hostSession) {
        return c.json(sessionStatePayload(hostSession, presentation, await BrowserHost.health()))
      }
      const session = await ensureSession(owner, { createInitialTab: true })
      return c.json(sessionPayload(session, presentation, await BrowserHost.health()))
    } catch (e: any) {
      log.error("browser session route error", { error: e?.message ?? String(e) })
      return c.json({ type: "error", code: "browser_session_failed", message: e?.message ?? "Browser error" }, 500)
    }
  })
  .post("/:directory/browser/control", async (c) => {
    const startedAt = Date.now()
    let state: BrowserRouteState | undefined
    let request: BrowserControlRequest | undefined
    try {
      state = routeState(c)
      request = await readControlRequest(c)
      request.traceId = traceId(c, request.traceId)
      const { owner, presentation } = state
      const { command } = request
      const tabId = commandTabId(owner, command)
      log.info("browser.route.control.received", {
        ownerKey: BrowserOwner.key(owner),
        scopeID: owner.scopeID,
        sessionID: owner.sessionID,
        client: state.client,
        presentation: presentation.kind,
        presentationReason: presentation.reason,
        tabId,
        commandId: request.commandId,
        commandType: command.type,
        traceId: request.traceId,
      })

      if (presentation.kind === "webrtc" && command.type === "createTab") {
        const result = await executeWebRTCCreateTab(state, command, request, requestOrigin(c))
        log.info("browser.route.control.completed", {
          ownerKey: BrowserOwner.key(owner),
          tabId: result.type === "tab" ? result.tab.id : tabId,
          commandId: request.commandId,
          commandType: command.type,
          traceId: request.traceId,
          durationMs: Date.now() - startedAt,
        })
        return c.json({ type: "control.result", result }, 202)
      }

      if (
        presentation.kind === "webrtc" &&
        command.type === "setViewport" &&
        tabId &&
        !BrowserHostControl.isReady(owner, tabId)
      ) {
        deferViewport(owner, command, request)
        return c.json(
          { type: "control.result", result: { type: "void" }, deferred: true, hostStatus: "pending" },
          202,
        )
      }

      if (
        presentation.kind === "webrtc" &&
        commandNeedsReadyHost(command) &&
        tabId &&
        !BrowserHostControl.isReady(owner, tabId)
      ) {
        BrowserHostControl.markStatus(owner, tabId, "pending", {
          traceId: request.traceId,
          reason: "control_received_before_host_ready",
        })
        log.info("browser.route.control.deferred", {
          ownerKey: BrowserOwner.key(owner),
          tabId,
          commandId: request.commandId,
          commandType: command.type,
          traceId: request.traceId,
          reason: "host_pending",
        })
        return c.json(hostPendingPayload({ command, commandId: request.commandId, traceId: request.traceId, tabId }), 409)
      }

      const result = await BrowserHost.execute(owner, command, {
        commandId: request.commandId,
        traceId: request.traceId,
      })
      log.info("browser.route.control.completed", {
        ownerKey: BrowserOwner.key(owner),
        tabId,
        commandId: request.commandId,
        commandType: command.type,
        traceId: request.traceId,
        durationMs: Date.now() - startedAt,
      })
      return c.json({ type: "control.result", result })
    } catch (e: any) {
      const command = request?.command
      const tabId = state && command ? commandTabId(state.owner, command) : null
      if (e instanceof BrowserHostControlNotAttachedError && state && command) {
        log.info("browser.route.control.deferred", {
          ownerKey: BrowserOwner.key(state.owner),
          tabId,
          commandId: request?.commandId,
          commandType: command.type,
          traceId: request?.traceId,
          reason: "host_not_attached",
        })
        return c.json(hostPendingPayload({ command, commandId: request?.commandId, traceId: request?.traceId, tabId }), 409)
      }
      log.error("browser.route.control.failed", {
        ownerKey: state ? BrowserOwner.key(state.owner) : undefined,
        tabId,
        commandId: request?.commandId,
        commandType: command?.type,
        traceId: request?.traceId,
        durationMs: Date.now() - startedAt,
        error: e?.message ?? String(e),
      })
      return c.json(
        {
          type: "error",
          code: "browser_control_failed",
          message: e?.message ?? "Browser error",
          retryable: false,
          traceId: request?.traceId,
          tabId,
          commandId: request?.commandId,
        },
        500,
      )
    }
  })
  .get(
    "/:directory/browser/events",
    upgradeWebSocket((c) => {
      let state: BrowserRouteState
      try {
        state = routeState(c)
      } catch (e: any) {
        return {
          onOpen(_e: any, ws: BrowserWS) {
            send(ws, { type: "error", code: "browser_events_route_failed", message: e?.message ?? String(e) })
            ws.close(1008, "Invalid browser events route")
          },
          onMessage() {},
          onClose() {},
        }
      }

      if (isCrossOriginRequest(c)) {
        log.warn("browser events WS rejected: cross-origin", {
          origin: c.req.header("origin"),
          host: c.req.header("host"),
        })
        return {
          onOpen(_e: any, ws: BrowserWS) {
            ws.close(1008, "Cross-origin not allowed")
          },
          onMessage() {},
          onClose() {},
        }
      }

      const { directory, owner, presentation, client } = state
      const routeTraceId = c.req.query("traceId")
      let unsubscribe: (() => void) | undefined
      let unsubscribeHost: (() => void) | undefined

      log.info("browser.route.events.connected", {
        directory,
        ownerKey: BrowserOwner.key(owner),
        scopeID: owner.scopeID,
        sessionID: owner.sessionID,
        client,
        presentation: presentation.kind,
        presentationReason: presentation.reason,
        traceId: routeTraceId,
      })
      log.info("browser.surface.opened", {
        directory,
        ownerKey: BrowserOwner.key(owner),
        scopeID: owner.scopeID,
        sessionID: owner.sessionID,
        client,
        presentation: presentation.kind,
        traceId: routeTraceId,
      })

      return {
        onOpen: async (_e: any, ws: BrowserWS) => {
          try {
            unsubscribeHost = BrowserHostControl.addObserver(owner, (event) => send(ws, event))
            const hostSession = BrowserHostControl.sessionState(owner)
            if (hostSession) {
              send(ws, sessionStatePayload(hostSession, presentation, await BrowserHost.health()))
              return
            }
            const session = await ensureSession(owner, { createInitialTab: true })
            unsubscribe = subscribeBrowserEvents(ws, session)
            send(ws, sessionPayload(session, presentation, await BrowserHost.health()))
          } catch (e: any) {
            log.error("browser events WS onOpen error", { error: e?.message ?? String(e) })
            send(ws, {
              type: "error",
              severity: "critical",
              code: "browser_events_open_failed",
              message: e?.message ?? "Failed to open browser session",
            })
            ws.close(1011, "Failed to open browser session")
          }
        },
        onMessage(_event: any, ws: BrowserWS) {
          send(ws, {
            type: "error",
            severity: "warning",
            code: "browser_events_read_only",
            message: "Browser events socket is read-only; send commands to /browser/control.",
          })
        },
        onClose() {
          unsubscribe?.()
          unsubscribeHost?.()
          log.info("browser.route.events.disconnected", {
            directory,
            ownerKey: BrowserOwner.key(owner),
            client,
            presentation: presentation.kind,
            traceId: routeTraceId,
          })
        },
        onError(_e: any) {
          log.warn("browser.route.events.error", {
            directory,
            ownerKey: BrowserOwner.key(owner),
            client,
            presentation: presentation.kind,
            traceId: routeTraceId,
            error: String(_e),
          })
        },
      }
    }),
  )
  .get(
    "/:directory/browser/host/control",
    upgradeWebSocket((c) => {
      let state: BrowserRouteState
      try {
        state = routeState(c)
      } catch (e: any) {
        return {
          onOpen(_e: any, ws: BrowserWS) {
            send(ws, { type: "error", code: "browser_host_route_failed", message: e?.message ?? String(e) })
            ws.close(1008, "Invalid browser host route")
          },
          onMessage() {},
          onClose() {},
        }
      }

      let connection: BrowserHostControl.HostConnection | undefined
      const hostTabId = c.req.query("tabId")
      const routeTraceId = c.req.query("traceId")

      return {
        onOpen(_event: any, ws: BrowserWS) {
          connection = BrowserHostControl.attach(state.owner, ws, { tabId: hostTabId, traceId: routeTraceId })
          log.info("browser.host.control.attached", {
            directory: state.directory,
            ownerKey: BrowserOwner.key(state.owner),
            scopeID: state.owner.scopeID,
            sessionID: state.owner.sessionID,
            client: state.client,
            presentation: state.presentation.kind,
            tabId: hostTabId,
            traceId: routeTraceId,
          })
          send(ws, { type: "browser.host.attached", protocolVersion: BrowserHost.protocolVersion })
        },
        onMessage(event: any) {
          if (!connection) return
          try {
            connection.handleMessage(JSON.parse(event.data as string))
          } catch {
            /* ignore malformed host messages */
          }
        },
        onClose(event: any) {
          if (connection) BrowserHostControl.detach(state.owner, connection)
          log.info("browser.host.control.detached", {
            directory: state.directory,
            ownerKey: BrowserOwner.key(state.owner),
            client: state.client,
            presentation: state.presentation.kind,
            tabId: hostTabId,
            traceId: routeTraceId,
            closeCode: event?.code,
            closeReason: event?.reason,
          })
        },
      }
    }),
  )
  .get(
    "/:directory/browser/webrtc/connect",
    upgradeWebSocket((c) => {
      let state: BrowserRouteState
      const initialTabId = c.req.query("tabId")
      const routeTraceId = c.req.query("traceId")
      try {
        state = routeState(c)
      } catch (e: any) {
        return {
          onOpen(_e: any, ws: BrowserWS) {
            send(ws, { type: "error", code: "browser_webrtc_route_failed", message: e?.message ?? String(e) })
            ws.close(1008, "Invalid browser WebRTC route")
          },
          onMessage() {},
          onClose() {},
        }
      }

      let attachedTabId: string | null = null

      return {
        onOpen: async (_e: any, ws: BrowserWS) => {
          const hostSession = BrowserHostControl.sessionState(state.owner)
          const session =
            hostSession ?? BrowserControl.sessionState(await ensureSession(state.owner, { createInitialTab: true }))
          const tabId = initialTabId || session.activeTabId || null
          const tab = tabId ? session.tabs.find((item) => item.id === tabId) : undefined
          if (tabId) {
            attachedTabId = tabId
            BrowserWebRTCSignaling.attachViewer(state.owner, tabId, ws)
            BrowserHostControl.markStatus(
              state.owner,
              tabId,
              BrowserHostControl.isReady(state.owner, tabId) ? "ready" : "pending",
              {
                traceId: routeTraceId,
                reason: "webrtc_viewer_connected",
              },
            )
            const ensure = BrowserElectronHostProcess.ensure({
              owner: state.owner,
              tabId,
              serverUrl: requestOrigin(c),
              routeDirectory: state.directory,
              url: tab?.url,
              traceId: routeTraceId,
            })
            log.info("browser.webrtc.viewer.connected", {
              directory: state.directory,
              ownerKey: BrowserOwner.key(state.owner),
              scopeID: state.owner.scopeID,
              sessionID: state.owner.sessionID,
              client: state.client,
              presentation: state.presentation.kind,
              tabId,
              traceId: routeTraceId,
              hostProcessKey: ensure.key,
              hostStatus: BrowserHostControl.status(state.owner, tabId),
            })
            if (!BrowserHostControl.isReady(state.owner, tabId)) {
              send(ws, {
                type: "browser.host.status",
                status: "pending",
                tabId,
                traceId: routeTraceId,
                reason: "webrtc_viewer_connected",
              })
              send(ws, {
                type: "webrtc.host.pending",
                tabId,
                traceId: routeTraceId,
                code: "browser_host_pending",
                message: "Waiting for Browser Host.",
              })
              void BrowserHostControl.waitForReady(state.owner, tabId, hostReadyTimeoutMs())
                .then(() => {
                  send(ws, { type: "browser.host.status", status: "ready", tabId, traceId: routeTraceId })
                  log.info("browser.webrtc.host.ready", {
                    ownerKey: BrowserOwner.key(state.owner),
                    tabId,
                    traceId: routeTraceId,
                    hostStatus: "ready",
                  })
                })
                .catch((error) => {
                  send(ws, {
                    type: "browser.host.status",
                    status: "failed",
                    tabId,
                    traceId: routeTraceId,
                    reason: error instanceof Error ? error.message : String(error),
                  })
                })
            }
          }
          send(ws, {
            type: "webrtc.signaling.ready",
            presentation: state.presentation,
            session,
            tabId,
            traceId: routeTraceId,
          })
        },
        onMessage: async (event: any, ws: BrowserWS) => {
          let msg: any
          try {
            msg = JSON.parse(event.data as string)
          } catch {
            send(ws, { type: "error", code: "browser_webrtc_invalid_message", message: "Invalid WebRTC message" })
            return
          }

          const tabId = typeof msg.tabId === "string" ? msg.tabId : attachedTabId
          if (!tabId) {
            send(ws, { type: "error", code: "browser_webrtc_missing_tab", message: "Missing WebRTC tab id" })
            return
          }

          attachedTabId = tabId
          BrowserWebRTCSignaling.handleViewerMessage(state.owner, tabId, ws, msg)
        },
        onClose(_event: any, ws: BrowserWS) {
          if (attachedTabId) BrowserWebRTCSignaling.detachViewer(state.owner, attachedTabId, ws)
          log.info("browser.webrtc.viewer.disconnected", {
            ownerKey: BrowserOwner.key(state.owner),
            tabId: attachedTabId,
            traceId: routeTraceId,
          })
        },
      }
    }),
  )
  .get(
    "/:directory/browser/webrtc/host",
    upgradeWebSocket((c) => {
      let state: BrowserRouteState
      const initialTabId = c.req.query("tabId")
      const routeTraceId = c.req.query("traceId")
      try {
        state = routeState(c)
      } catch (e: any) {
        return {
          onOpen(_e: any, ws: BrowserWS) {
            send(ws, { type: "error", code: "browser_webrtc_host_route_failed", message: e?.message ?? String(e) })
            ws.close(1008, "Invalid browser WebRTC host route")
          },
          onMessage() {},
          onClose() {},
        }
      }

      let attachedTabId: string | null = initialTabId ?? null

      return {
        onOpen: async (_e: any, ws: BrowserWS) => {
          const hostSession = BrowserHostControl.sessionState(state.owner)
          const session =
            hostSession ?? BrowserControl.sessionState(await ensureSession(state.owner, { createInitialTab: true }))
          attachedTabId = attachedTabId || session.activeTabId || null
          if (!attachedTabId) {
            send(ws, { type: "error", code: "browser_webrtc_host_missing_tab", message: "Missing WebRTC host tab id" })
            ws.close(1008, "Missing WebRTC host tab id")
            return
          }
          BrowserWebRTCSignaling.attachHost(state.owner, attachedTabId, ws)
          log.info("browser.webrtc.host.connected", {
            directory: state.directory,
            ownerKey: BrowserOwner.key(state.owner),
            scopeID: state.owner.scopeID,
            sessionID: state.owner.sessionID,
            client: state.client,
            presentation: state.presentation.kind,
            tabId: attachedTabId,
            traceId: routeTraceId,
          })
          send(ws, {
            type: "webrtc.host.signaling.ready",
            presentation: state.presentation,
            session,
            tabId: attachedTabId,
            traceId: routeTraceId,
          })
        },
        onMessage(event: any, ws: BrowserWS) {
          let msg: any
          try {
            msg = JSON.parse(event.data as string)
          } catch {
            send(ws, { type: "error", code: "browser_webrtc_host_invalid_message", message: "Invalid WebRTC message" })
            return
          }

          const tabId = typeof msg.tabId === "string" ? msg.tabId : attachedTabId
          if (!tabId) return
          attachedTabId = tabId
          BrowserWebRTCSignaling.handleHostMessage(state.owner, tabId, msg)
        },
        onClose(_event: any, ws: BrowserWS) {
          if (attachedTabId) BrowserWebRTCSignaling.detachHost(state.owner, attachedTabId, ws)
          log.info("browser.webrtc.host.disconnected", {
            ownerKey: BrowserOwner.key(state.owner),
            tabId: attachedTabId,
            traceId: routeTraceId,
          })
        },
      }
    }),
  )

function isSameOrigin(origin: string, host: string): boolean {
  try {
    const originURL = new URL(origin)
    const hostOnly = host.split(":")[0] ?? host
    return originURL.hostname === "localhost" || originURL.hostname === "127.0.0.1" || originURL.hostname === hostOnly
  } catch {
    return false
  }
}
