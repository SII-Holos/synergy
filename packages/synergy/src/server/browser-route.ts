import type { BrowserSession } from "../browser/types.js"
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
import { BrowserWorkspace } from "../browser/workspace.js"
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

function send(ws: BrowserWS, payload: Record<string, unknown>) {
  try {
    ws.send(JSON.stringify(payload))
  } catch {
    // The socket may have closed between async browser events.
  }
}

function subscribeBrowserEvents(ws: BrowserWS, session: BrowserSession) {
  return session.addObserver({
    onPageCreated: (page) => {
      send(ws, { type: "page.created", page: BrowserWorkspace.pagePayload(page) })
    },
    onPageClosed: (pageId) => {
      send(ws, { type: "page.closed", pageId })
    },
    onPageUpdated: (page) => {
      send(ws, { type: "page.updated", page: BrowserWorkspace.pagePayload(page) })
    },
    onPageNavigated: (page) => {
      send(ws, { type: "page.updated", page: BrowserWorkspace.pagePayload(page) })
    },
    onPageLoadState: (page, state, message) => {
      const type = state === "loading" ? "page.loading" : state === "loaded" ? "page.loaded" : "page.error"
      send(ws, { type, pageId: page.id, url: page.url, title: page.title, message })
    },
    onAgentActivity: (activity) => {
      send(ws, { type: "agent.activity", ...activity })
    },
    onControlChanged: (mode) => {
      send(ws, { type: "control.changed", mode })
    },
    onDownload: (page, entry) => {
      send(ws, { type: "downloads.updated", pageId: page.id, entry })
    },
    onFileChooser: (page, request) => {
      send(ws, { type: "filechooser.request", pageId: page.id, ...request })
    },
    onDialog: (page, request) => {
      send(ws, {
        type: "dialog.opened",
        pageId: page.id,
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

export const BrowserRoute = new Hono()
  .get("/:directory/browser/session", async (c) => {
    try {
      const state = routeState(c)
      const session = await BrowserWorkspace.sessionState(state)
      return c.json(BrowserWorkspace.sessionStatePayload(session, state.presentation, await BrowserHost.health()))
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
      const pageId = BrowserWorkspace.commandPageId(owner, command)
      log.info("browser.route.control.received", {
        ownerKey: BrowserOwner.key(owner),
        scopeID: owner.scopeID,
        sessionID: owner.sessionID,
        client: state.client,
        presentation: presentation.kind,
        presentationReason: presentation.reason,
        pageId,
        commandId: request.commandId,
        commandType: command.type,
        traceId: request.traceId,
      })

      const result = await BrowserWorkspace.executeControl(state, request, requestOrigin(c))
      log.info("browser.route.control.completed", {
        ownerKey: BrowserOwner.key(owner),
        pageId: result.pageId,
        commandId: request.commandId,
        commandType: command.type,
        traceId: request.traceId,
        durationMs: Date.now() - startedAt,
      })
      return c.json(result.payload, result.status as any)
    } catch (e: any) {
      const command = request?.command
      const pageId = state && command ? BrowserWorkspace.commandPageId(state.owner, command) : null
      if (e instanceof BrowserControl.PageMissingError && state && command) {
        return c.json(
          BrowserWorkspace.pageMissingPayload({
            command,
            commandId: request?.commandId,
            traceId: request?.traceId,
            pageId,
          }),
          409,
        )
      }
      if (e instanceof BrowserHostControlNotAttachedError && state && command) {
        log.info("browser.route.control.deferred", {
          ownerKey: BrowserOwner.key(state.owner),
          pageId,
          commandId: request?.commandId,
          commandType: command.type,
          traceId: request?.traceId,
          reason: "host_not_attached",
        })
        return c.json(
          BrowserWorkspace.hostPendingPayload({
            command,
            commandId: request?.commandId,
            traceId: request?.traceId,
            pageId,
          }),
          409,
        )
      }
      log.error("browser.route.control.failed", {
        ownerKey: state ? BrowserOwner.key(state.owner) : undefined,
        pageId,
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
          pageId,
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
            const session = await BrowserWorkspace.ensureSession(owner)
            unsubscribe = subscribeBrowserEvents(ws, session)
            unsubscribeHost = BrowserHostControl.addObserver(owner, (event) => {
              if (presentation.kind === "webrtc" && event.type === "session.state") {
                const hostSession = { page: event.page ?? null } as BrowserControl.SessionState
                send(ws, {
                  type: "session.state",
                  ...BrowserWorkspace.mergeCanonicalHostSession(BrowserControl.sessionState(session), hostSession),
                })
                return
              }
              send(ws, event)
            })
            const hostSession = BrowserHostControl.sessionState(owner)
            if (hostSession && presentation.kind === "webrtc") {
              send(
                ws,
                BrowserWorkspace.sessionStatePayload(
                  BrowserWorkspace.mergeCanonicalHostSession(BrowserControl.sessionState(session), hostSession),
                  presentation,
                  await BrowserHost.health(),
                ),
              )
              return
            }
            if (hostSession) {
              send(ws, BrowserWorkspace.sessionStatePayload(hostSession, presentation, await BrowserHost.health()))
              return
            }
            send(
              ws,
              BrowserWorkspace.sessionStatePayload(
                BrowserControl.sessionState(session),
                presentation,
                await BrowserHost.health(),
              ),
            )
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
      const hostPageId = c.req.query("pageId")
      const routeTraceId = c.req.query("traceId")

      return {
        onOpen(_event: any, ws: BrowserWS) {
          connection = BrowserHostControl.attach(state.owner, ws, { pageId: hostPageId, traceId: routeTraceId })
          log.info("browser.host.control.attached", {
            directory: state.directory,
            ownerKey: BrowserOwner.key(state.owner),
            scopeID: state.owner.scopeID,
            sessionID: state.owner.sessionID,
            client: state.client,
            presentation: state.presentation.kind,
            pageId: hostPageId,
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
            pageId: hostPageId,
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
      const initialPageId = c.req.query("pageId")
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

      let attachedPageId: string | null = null

      return {
        onOpen: async (_e: any, ws: BrowserWS) => {
          const session = await BrowserWorkspace.sessionState(state)
          const pageId = initialPageId || session.page?.id || null
          const page = pageId === session.page?.id ? session.page : undefined
          if (pageId) {
            attachedPageId = pageId
            const hostReady = BrowserHostControl.isReady(state.owner, pageId)
            BrowserWebRTCSignaling.attachViewer(state.owner, pageId, ws, { hostReady })
            BrowserHostControl.markStatus(state.owner, pageId, hostReady ? "ready" : "pending", {
              traceId: routeTraceId,
              reason: "webrtc_viewer_connected",
            })
            const ensure = BrowserElectronHostProcess.ensure({
              owner: state.owner,
              pageId,
              serverUrl: requestOrigin(c),
              routeDirectory: state.directory,
              url: page?.url,
              traceId: routeTraceId,
            })
            log.info("browser.webrtc.viewer.connected", {
              directory: state.directory,
              ownerKey: BrowserOwner.key(state.owner),
              scopeID: state.owner.scopeID,
              sessionID: state.owner.sessionID,
              client: state.client,
              presentation: state.presentation.kind,
              pageId,
              traceId: routeTraceId,
              hostProcessKey: ensure.key,
              hostStatus: BrowserHostControl.status(state.owner, pageId),
            })
            if (!hostReady) {
              send(ws, {
                type: "browser.host.status",
                status: "pending",
                pageId,
                traceId: routeTraceId,
                reason: "webrtc_viewer_connected",
              })
              send(ws, {
                type: "webrtc.host.pending",
                pageId,
                traceId: routeTraceId,
                code: "browser_host_pending",
                message: "Waiting for Browser Host.",
              })
              void BrowserHostControl.waitForReady(state.owner, pageId, BrowserWorkspace.hostReadyTimeoutMs())
                .then(() => {
                  send(ws, { type: "browser.host.status", status: "ready", pageId, traceId: routeTraceId })
                  BrowserWebRTCSignaling.notifyHostReady(state.owner, pageId, routeTraceId)
                  log.info("browser.webrtc.host.ready", {
                    ownerKey: BrowserOwner.key(state.owner),
                    pageId,
                    traceId: routeTraceId,
                    hostStatus: "ready",
                  })
                })
                .catch((error) => {
                  send(ws, {
                    type: "browser.host.status",
                    status: "failed",
                    pageId,
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
            pageId,
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

          const pageId = typeof msg.pageId === "string" ? msg.pageId : attachedPageId
          if (!pageId) {
            send(ws, { type: "error", code: "browser_webrtc_missing_page", message: "Missing WebRTC page id" })
            return
          }

          attachedPageId = pageId
          log.info("browser.webrtc.viewer.signal", {
            ownerKey: BrowserOwner.key(state.owner),
            pageId,
            traceId: typeof msg.traceId === "string" ? msg.traceId : routeTraceId,
            signalType: msg.type,
            hasSdp: typeof msg.sdp === "string",
            hasCandidate: Boolean(msg.candidate),
          })
          BrowserWebRTCSignaling.handleViewerMessage(state.owner, pageId, ws, msg)
        },
        onClose(_event: any, ws: BrowserWS) {
          if (attachedPageId) BrowserWebRTCSignaling.detachViewer(state.owner, attachedPageId, ws)
          log.info("browser.webrtc.viewer.disconnected", {
            ownerKey: BrowserOwner.key(state.owner),
            pageId: attachedPageId,
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
      const initialPageId = c.req.query("pageId")
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

      let attachedPageId: string | null = initialPageId ?? null

      return {
        onOpen: async (_e: any, ws: BrowserWS) => {
          const session = await BrowserWorkspace.sessionState(state)
          attachedPageId = attachedPageId || session.page?.id || null
          if (!attachedPageId) {
            send(ws, {
              type: "error",
              code: "browser_webrtc_host_missing_page",
              message: "Missing WebRTC host page id",
            })
            ws.close(1008, "Missing WebRTC host page id")
            return
          }
          BrowserWebRTCSignaling.attachHost(state.owner, attachedPageId, ws, {
            hostReady: BrowserHostControl.isReady(state.owner, attachedPageId),
          })
          log.info("browser.webrtc.host.connected", {
            directory: state.directory,
            ownerKey: BrowserOwner.key(state.owner),
            scopeID: state.owner.scopeID,
            sessionID: state.owner.sessionID,
            client: state.client,
            presentation: state.presentation.kind,
            pageId: attachedPageId,
            traceId: routeTraceId,
          })
          send(ws, {
            type: "webrtc.host.signaling.ready",
            presentation: state.presentation,
            session,
            pageId: attachedPageId,
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

          const pageId = typeof msg.pageId === "string" ? msg.pageId : attachedPageId
          if (!pageId) return
          attachedPageId = pageId
          log.info("browser.webrtc.host.signal", {
            ownerKey: BrowserOwner.key(state.owner),
            pageId,
            traceId: typeof msg.traceId === "string" ? msg.traceId : routeTraceId,
            signalType: msg.type,
            hasSdp: typeof msg.sdp === "string",
            hasCandidate: Boolean(msg.candidate),
          })
          BrowserWebRTCSignaling.handleHostMessage(state.owner, pageId, msg)
        },
        onClose(_event: any, ws: BrowserWS) {
          if (attachedPageId) BrowserWebRTCSignaling.detachHost(state.owner, attachedPageId, ws)
          log.info("browser.webrtc.host.disconnected", {
            ownerKey: BrowserOwner.key(state.owner),
            pageId: attachedPageId,
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
