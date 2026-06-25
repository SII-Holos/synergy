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
import { BrowserHostControl } from "../browser/host-control.js"
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
}

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
  return { directory, owner, presentation }
}

async function ensureSession(
  owner: BrowserOwner.Info,
  options?: BrowserHost.EnsureSessionOptions,
): Promise<BrowserSession> {
  return BrowserHost.ensureSession(owner, options)
}

async function readControlCommand(c: BrowserRouteContext): Promise<BrowserControl.Command> {
  const body = await c.req.json()
  const command =
    typeof body === "object" && body !== null && "command" in body ? (body as { command: unknown }).command : body
  if (typeof command !== "object" || command === null || typeof (command as { type?: unknown }).type !== "string") {
    throw new Error("Invalid browser control command")
  }
  return command as BrowserControl.Command
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
    try {
      const { owner } = routeState(c)
      const command = await readControlCommand(c)
      const result = await BrowserHost.execute(owner, command)
      return c.json({ type: "control.result", result })
    } catch (e: any) {
      log.error("browser control route error", { error: e?.message ?? String(e) })
      return c.json({ type: "error", code: "browser_control_failed", message: e?.message ?? "Browser error" }, 500)
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

      const { directory, owner, presentation } = state
      let unsubscribe: (() => void) | undefined
      let unsubscribeHost: (() => void) | undefined

      log.info("browser events WebSocket connected", {
        directory,
        ownerKey: BrowserOwner.key(owner),
        presentation: presentation.kind,
        presentationReason: presentation.reason,
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
          log.info("browser events WebSocket disconnected")
        },
        onError(_e: any) {
          log.warn("browser events WebSocket error", { error: String(_e) })
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

      return {
        onOpen(_event: any, ws: BrowserWS) {
          connection = BrowserHostControl.attach(state.owner, ws)
          log.info("browser host control connected", {
            directory: state.directory,
            ownerKey: BrowserOwner.key(state.owner),
            presentation: state.presentation.kind,
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
        onClose() {
          if (connection) BrowserHostControl.detach(state.owner, connection)
          log.info("browser host control disconnected")
        },
      }
    }),
  )
  .get(
    "/:directory/browser/webrtc/connect",
    upgradeWebSocket((c) => {
      let state: BrowserRouteState
      const initialTabId = c.req.query("tabId")
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
            BrowserElectronHostProcess.ensure({
              owner: state.owner,
              tabId,
              serverUrl: requestOrigin(c),
              routeDirectory: state.directory,
              url: tab?.url,
            })
          }
          send(ws, {
            type: "webrtc.signaling.ready",
            presentation: state.presentation,
            session,
            tabId,
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
        },
      }
    }),
  )
  .get(
    "/:directory/browser/webrtc/host",
    upgradeWebSocket((c) => {
      let state: BrowserRouteState
      const initialTabId = c.req.query("tabId")
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
          const session = await ensureSession(state.owner, { createInitialTab: true })
          attachedTabId = attachedTabId || session.activeTab?.id || null
          if (!attachedTabId) {
            send(ws, { type: "error", code: "browser_webrtc_host_missing_tab", message: "Missing WebRTC host tab id" })
            ws.close(1008, "Missing WebRTC host tab id")
            return
          }
          BrowserWebRTCSignaling.attachHost(state.owner, attachedTabId, ws)
          send(ws, {
            type: "webrtc.host.signaling.ready",
            presentation: state.presentation,
            session: BrowserControl.sessionState(session),
            tabId: attachedTabId,
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
