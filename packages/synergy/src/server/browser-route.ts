import {
  BROWSER_PROTOCOL_VERSION,
  BrowserProtocolError,
  BrowserControlRequestSchema,
  BrowserControlResponseSchema,
  BrowserAPIErrorSchema,
  BrowserViewerTicketRequestSchema,
  BrowserViewerTicketResponseSchema,
  BrowserAnnotationRequestSchema,
  BrowserAnnotationResponseSchema,
  BrowserDiagnosticsRequestSchema,
  BrowserDiagnosticsResponseSchema,
  BrowserAPISessionStateSchema,
  BrowserWebRTCMessageSchema,
  BrowserWebRTCSignalSchema,
  parseBrowserPresentationPreference,
  type BrowserPresentationSelection,
} from "@ericsanchezok/synergy-browser"
import { Hono, type Context, type Next } from "hono"
import { upgradeWebSocket } from "hono/bun"
import { describeRoute, resolver, validator } from "hono-openapi"
import { BrowserBroker } from "../browser/broker.js"
import { BrowserControl } from "../browser/control.js"
import { BrowserHost } from "../browser/host.js"
import { BrowserOwner } from "../browser/owner.js"
import { BrowserWebRTCSignaling } from "../browser/webrtc-signaling.js"
import { BrowserWorkspace } from "../browser/workspace.js"
import { BrowserTicket } from "../browser/ticket.js"
import { BrowserDownloads } from "../browser/downloads.js"
import { BrowserAssets } from "../browser/assets.js"
import { BrowserCommandService } from "../browser/command-service.js"
import { BrowserEvent } from "../browser/event.js"
import { BrowserNativePresentation } from "../browser/native-presentation.js"
import { ScopeContext } from "../scope/context"
import { Log } from "../util/log"
import z from "zod"

const log = Log.create({ service: "browser.route" })
const MAX_CONTROL_BYTES = 70 * 1024 * 1024
const MAX_BROKER_BYTES = 80 * 1024 * 1024
const MAX_TICKET_BYTES = 16 * 1024
const MAX_ANNOTATION_BYTES = 256 * 1024
const MAX_DIAGNOSTICS_BYTES = 64 * 1024
const payloadTooLargeResponse = {
  description: "Browser request payload is too large",
  content: { "application/json": { schema: resolver(BrowserAPIErrorSchema) } },
} as const
const BrowserRouteQuery = z
  .object({
    mode: z.enum(["session", "scope"]).default("session"),
    sessionID: z.string().min(1).max(1_000).optional(),
    presentation: z.enum(["auto", "native", "webrtc"]).default("auto"),
    directory: z.string().max(20_000).optional(),
    scopeID: z.string().max(1_000).optional(),
    protocolVersion: z.coerce.number().pipe(z.literal(BROWSER_PROTOCOL_VERSION)).default(BROWSER_PROTOCOL_VERSION),
    sinceSeq: z.coerce.number().int().nonnegative().optional(),
    epoch: z.string().min(1).max(20_000).optional(),
    nativeTicket: z.string().max(4_096).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "session" && !value.sessionID) {
      ctx.addIssue({ code: "custom", path: ["sessionID"], message: "sessionID is required for session mode." })
    }
    if (value.mode === "scope" && value.sessionID !== undefined) {
      ctx.addIssue({ code: "custom", path: ["sessionID"], message: "sessionID is not valid for scope mode." })
    }
  })

interface BrowserWS {
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface RouteState {
  directory: string
  owner: BrowserOwner.Info
  presentation: BrowserPresentationSelection
  requestedPresentation: "auto" | "native" | "webrtc"
  nativePresentation: boolean
}

function routeState(c: {
  req: { url: string; param(name: string): string; query(name: string): string | undefined }
}): RouteState {
  const directory = c.req.param("directory")
  if (!directory) throw new Error("Missing directory")
  const mode = (c.req.query("mode") ?? "session") as BrowserOwner.Mode
  const owner = BrowserOwner.fromRoute({
    directory: ScopeContext.current.directory,
    scopeID: ScopeContext.current.scope.id,
    sessionID: c.req.query("sessionID"),
    mode,
  })
  BrowserOwner.assertValid(owner)
  const capabilities = BrowserHost.capabilities()
  const nativePresentation = BrowserNativePresentation.consume(
    owner,
    new URL(c.req.url).origin,
    c.req.query("nativeTicket"),
  )
  const requestedPresentation = parseBrowserPresentationPreference(c.req.query("presentation"))
  const presentation = BrowserHost.presentation({
    desktopLocalHost: nativePresentation,
    remote: !nativePresentation,
    requested: requestedPresentation,
  })
  return { directory, owner, presentation, requestedPresentation, nativePresentation }
}

function send(ws: BrowserWS, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload))
  } catch {}
}

export const BrowserRoute = new Hono()
  .get(
    "/browser/host/broker",
    upgradeWebSocket((c) => {
      try {
        assertWebSocketRequest(c, "host")
      } catch (error) {
        return rejectedSocket(error)
      }
      let registered = false
      let brokerSocket: BrowserWS | null = null
      return {
        onOpen() {},
        onMessage(event: any, ws: BrowserWS) {
          const raw = String(event.data ?? "")
          if (Buffer.byteLength(raw, "utf8") > MAX_BROKER_BYTES) {
            ws.close(1009, "Browser Host message is too large")
            return
          }
          try {
            const message = JSON.parse(raw)
            if (!registered) {
              BrowserBroker.attach(ws, message)
              registered = true
              brokerSocket = ws
            } else {
              BrowserBroker.handle(brokerSocket!, message)
            }
          } catch (error) {
            log.warn("browser host broker rejected message", {
              error: error instanceof Error ? error.message : String(error),
            })
            ws.close(1008, "Invalid Browser Host message")
          }
        },
        onClose(_event: unknown, ws: BrowserWS) {
          BrowserBroker.detach(brokerSocket ?? ws)
          brokerSocket = null
        },
      }
    }),
  )
  .post(
    "/:directory/browser/webrtc/ticket",
    describeRoute({
      summary: "Create a Browser viewer ticket",
      description: "Create a short-lived single-use ticket for the active Browser page's WebRTC viewer.",
      operationId: "browser.createViewerTicket",
      responses: {
        200: {
          description: "Browser viewer ticket",
          content: { "application/json": { schema: resolver(BrowserViewerTicketResponseSchema) } },
        },
        400: {
          description: "Ticket request rejected",
          content: { "application/json": { schema: resolver(BrowserAPIErrorSchema) } },
        },
        413: payloadTooLargeResponse,
      },
    }),
    limitBrowserBody(MAX_TICKET_BYTES),
    validator("query", BrowserRouteQuery),
    validator("json", BrowserViewerTicketRequestSchema),
    async (c) => {
      try {
        const state = routeState(c)
        const body = c.req.valid("json")
        const session = await BrowserWorkspace.sessionState(state)
        if (
          session.status !== "active" ||
          !session.page ||
          session.page.id !== body.pageId ||
          !BrowserBroker.hasPage(state.owner, body.pageId)
        ) {
          throw new BrowserProtocolError({
            code: "browser_ticket_page_unavailable",
            message: "The requested Browser page is not active.",
            retryable: true,
            pageId: body.pageId,
          })
        }
        if (!BrowserBroker.ready("webrtc")) {
          throw new BrowserProtocolError({
            code: "browser_host_unavailable",
            message: "The WebRTC Browser Host is not ready.",
            retryable: true,
            pageId: body.pageId,
          })
        }
        const issued = BrowserTicket.issue(state.owner, body.pageId, "viewer")
        return c.json({
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          ...issued,
          iceServers: browserIceServers(),
        })
      } catch (error) {
        return c.json(protocolError(error, "browser_ticket_failed"), 400)
      }
    },
  )
  .post(
    "/:directory/browser/annotations",
    describeRoute({
      summary: "Create a Browser annotation",
      description: "Attach user feedback to a coordinate on the active Browser page.",
      operationId: "browser.createAnnotation",
      responses: {
        200: {
          description: "Created Browser annotation",
          content: { "application/json": { schema: resolver(BrowserAnnotationResponseSchema) } },
        },
        400: {
          description: "Annotation request rejected",
          content: { "application/json": { schema: resolver(BrowserAPIErrorSchema) } },
        },
        413: payloadTooLargeResponse,
      },
    }),
    limitBrowserBody(MAX_ANNOTATION_BYTES),
    validator("query", BrowserRouteQuery),
    validator("json", BrowserAnnotationRequestSchema),
    async (c) => {
      try {
        const state = routeState(c)
        const body = c.req.valid("json")
        const session = await BrowserWorkspace.ensureSession(state.owner)
        const page = session.page
        if (!page || page.id !== body.pageId) {
          throw new BrowserProtocolError({
            code: "browser_annotation_page_unavailable",
            message: "The annotated Browser page is not active.",
            retryable: true,
            pageId: body.pageId,
          })
        }
        const annotation = await session.addAnnotation({
          pageID: page.id,
          pageURL: page.url,
          element: `point(${Math.round(body.x)},${Math.round(body.y)})`,
          comment: body.comment,
          styleFeedback: body.styleFeedback,
          createdBy: "user",
        })
        return c.json({ protocolVersion: BROWSER_PROTOCOL_VERSION, annotation })
      } catch (error) {
        return c.json(protocolError(error, "browser_annotation_failed"), 400)
      }
    },
  )
  .post(
    "/:directory/browser/diagnostics",
    describeRoute({
      summary: "Read Browser diagnostics",
      description: "Read bounded console, network, element, asset, or download diagnostics for the active page.",
      operationId: "browser.diagnostics",
      responses: {
        200: {
          description: "Browser diagnostics result",
          content: { "application/json": { schema: resolver(BrowserDiagnosticsResponseSchema) } },
        },
        400: {
          description: "Diagnostics request rejected",
          content: { "application/json": { schema: resolver(BrowserAPIErrorSchema) } },
        },
        413: payloadTooLargeResponse,
      },
    }),
    limitBrowserBody(MAX_DIAGNOSTICS_BYTES),
    validator("query", BrowserRouteQuery),
    validator("json", BrowserDiagnosticsRequestSchema),
    async (c) => {
      let commandId: string | undefined
      try {
        const state = routeState(c)
        const body = c.req.valid("json")
        commandId = body.commandId
        const session = await BrowserWorkspace.ensureSession(state.owner)
        if (!session.page || session.page.id !== body.pageId) {
          throw new BrowserProtocolError({
            code: "browser_diagnostics_page_unavailable",
            message: "The requested Browser page is not active.",
            retryable: true,
            pageId: body.pageId,
            commandId,
          })
        }
        const data = await diagnosticsData(state.owner, body)
        return c.json({
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          pageId: body.pageId,
          action: body.action,
          data,
        })
      } catch (error) {
        return c.json(protocolError(error, "browser_diagnostics_failed", commandId), 400)
      }
    },
  )
  .get(
    "/:directory/browser/session",
    describeRoute({
      summary: "Get Browser session state",
      description: "Read the browser session descriptor without creating, resuming, or navigating a page.",
      operationId: "browser.session",
      responses: {
        200: {
          description: "Browser session state",
          content: { "application/json": { schema: resolver(BrowserAPISessionStateSchema) } },
        },
        500: {
          description: "Browser session error",
          content: { "application/json": { schema: resolver(BrowserAPIErrorSchema) } },
        },
      },
    }),
    validator("query", BrowserRouteQuery),
    async (c) => {
      try {
        const state = routeState(c)
        const session = await BrowserWorkspace.sessionState(state)
        const payload = BrowserWorkspace.sessionStatePayload(state.owner, session, state.presentation)
        c.header("x-synergy-seq", String(payload.seq))
        c.header("x-synergy-epoch", payload.epoch)
        return c.json(payload)
      } catch (error) {
        return c.json(protocolError(error, "browser_session_failed"), 500)
      }
    },
  )
  .post(
    "/:directory/browser/control",
    describeRoute({
      summary: "Control the Browser workspace",
      description: "Send one strict user navigation, lifecycle, viewport, dialog, or file chooser command.",
      operationId: "browser.control",
      responses: {
        200: {
          description: "Browser control result",
          content: { "application/json": { schema: resolver(BrowserControlResponseSchema) } },
        },
        400: {
          description: "Invalid browser command",
          content: { "application/json": { schema: resolver(BrowserAPIErrorSchema) } },
        },
        409: {
          description: "Retryable browser error",
          content: { "application/json": { schema: resolver(BrowserAPIErrorSchema) } },
        },
        413: payloadTooLargeResponse,
      },
    }),
    limitBrowserBody(MAX_CONTROL_BYTES),
    async (c, next) => {
      const input = await c.req.json().catch(() => null)
      if (!input || typeof input !== "object" || typeof (input as Record<string, unknown>).commandId !== "string") {
        return c.json(
          new BrowserProtocolError({
            code: "browser_command_id_required",
            message: "commandId is required.",
            retryable: false,
          }).toJSON(),
          400,
        )
      }
      await next()
    },
    validator("query", BrowserRouteQuery),
    validator("json", BrowserControlRequestSchema, (result, c) => {
      if (result.success) return
      const validationError = result.error as
        | Array<{ path?: PropertyKey[]; message?: string }>
        | { issues?: Array<{ path?: PropertyKey[]; message?: string }> }
      const issues = Array.isArray(validationError) ? validationError : (validationError.issues ?? [])
      const missingCommandId = issues.some((issue) => issue.path?.[0] === "commandId")
      return c.json(
        new BrowserProtocolError({
          code: missingCommandId ? "browser_command_id_required" : "browser_invalid_command",
          message: missingCommandId
            ? "commandId is required."
            : issues.map((issue) => `${issue.path?.join(".") || "command"}: ${issue.message ?? "invalid"}`).join("; "),
          retryable: false,
        }).toJSON(),
        400,
      )
    }),
    async (c) => {
      let commandId: string | undefined
      try {
        const state = routeState(c)
        const body = c.req.valid("json")
        commandId = body.commandId
        const command = body.command
        const result = await BrowserWorkspace.executeControl(
          state,
          { command, commandId, traceId: body.traceId },
          new URL(c.req.url).origin,
        )
        return c.json(result.payload, result.status as 200)
      } catch (error) {
        const normalized = protocolError(error, "browser_control_failed", commandId)
        return c.json(normalized, normalized.retryable ? 409 : 400)
      }
    },
  )
  .get(
    "/:directory/browser/events",
    upgradeWebSocket((c) => {
      let state: RouteState
      try {
        assertWebSocketRequest(c, "viewer")
        state = routeState(c)
      } catch (error) {
        return rejectedSocket(error)
      }
      let unsubscribe: (() => void) | undefined
      return {
        async onOpen(_event: unknown, ws: BrowserWS) {
          try {
            const session = await BrowserWorkspace.ensureSession(state.owner)
            unsubscribe = BrowserEvent.subscribe(state.owner, (event) => send(ws, event))
            const sinceSeq = Number(c.req.query("sinceSeq") ?? 0)
            const replay = BrowserEvent.replay(state.owner, sinceSeq, c.req.query("epoch"))
            if (replay) for (const event of replay) send(ws, event)
            send(
              ws,
              BrowserWorkspace.sessionStatePayload(
                state.owner,
                BrowserControl.sessionState(session),
                state.presentation,
              ),
            )
          } catch (error) {
            send(ws, protocolError(error, "browser_events_open_failed"))
            ws.close(1011, "Browser events failed")
          }
        },
        onMessage(event: any, ws: BrowserWS) {
          if (Buffer.byteLength(String(event.data ?? ""), "utf8") > 4 * 1024) {
            ws.close(1009, "Browser events message is too large")
            return
          }
          send(ws, protocolError(new Error("Browser events socket is read-only."), "browser_events_read_only"))
        },
        onClose() {
          unsubscribe?.()
        },
      }
    }),
  )
  .get(
    "/:directory/browser/webrtc/connect",
    upgradeWebSocket((c) => signalingSocket(c, "viewer")),
  )
  .get(
    "/:directory/browser/webrtc/host",
    upgradeWebSocket((c) => signalingSocket(c, "host")),
  )

function signalingSocket(c: any, role: "viewer" | "host") {
  let state: RouteState
  try {
    assertWebSocketRequest(c, role)
    state = routeState(c)
  } catch (error) {
    return rejectedSocket(error)
  }
  let pageId = c.req.query("pageId") as string | undefined
  let socket: BrowserWS | undefined
  let messageWindowStartedAt = Date.now()
  let messageCount = 0
  return {
    async onOpen(_event: unknown, ws: BrowserWS) {
      socket = ws
      try {
        const session = await BrowserWorkspace.sessionState(state)
        pageId ||= session.page?.id
        if (
          !pageId ||
          session.status !== "active" ||
          session.page?.id !== pageId ||
          !BrowserBroker.hasPage(state.owner, pageId)
        ) {
          throw new BrowserProtocolError({
            code: "browser_webrtc_missing_page",
            message: "No active Browser Host page is available for WebRTC.",
            retryable: true,
            pageId,
          })
        }
        BrowserTicket.consume(state.owner, pageId, role, c.req.query("ticket"))
        if (role === "viewer") BrowserWebRTCSignaling.attachViewer(state.owner, pageId, ws, { hostReady: true })
        else BrowserWebRTCSignaling.attachHost(state.owner, pageId, ws, { hostReady: true })
        send(
          ws,
          BrowserWebRTCMessageSchema.parse({
            type: role === "viewer" ? "webrtc.signaling.ready" : "webrtc.host.signaling.ready",
            protocolVersion: BROWSER_PROTOCOL_VERSION,
            presentation: state.presentation,
            session: BrowserWorkspace.sessionStatePayload(state.owner, session, state.presentation),
            pageId,
          }),
        )
      } catch (error) {
        send(ws, protocolError(error, "browser_ticket_rejected"))
        ws.close(1008, "Invalid Browser signaling session")
      }
    },
    onMessage(event: any, ws: BrowserWS) {
      if (!pageId) return
      const now = Date.now()
      if (now - messageWindowStartedAt >= 1_000) {
        messageWindowStartedAt = now
        messageCount = 0
      }
      messageCount++
      if (messageCount > 500) {
        ws.close(1008, "Browser signaling rate exceeded")
        return
      }
      if (Buffer.byteLength(String(event.data ?? ""), "utf8") > 256 * 1024) {
        ws.close(1009, "Browser signaling message is too large")
        return
      }
      let message
      try {
        message = BrowserWebRTCSignalSchema.parse(JSON.parse(String(event.data)))
      } catch (error) {
        send(ws, protocolError(error, "browser_webrtc_invalid_message"))
        return
      }
      if (message.pageId !== pageId) {
        send(
          ws,
          protocolError(new Error("WebRTC pageId does not match the attached page."), "browser_webrtc_cross_page"),
        )
        return
      }
      if (!BrowserWebRTCSignaling.acceptsRole(role, message)) {
        send(
          ws,
          protocolError(
            new Error(`WebRTC ${message.type} is not valid for the ${role} role.`),
            "browser_webrtc_role_mismatch",
          ),
        )
        ws.close(1008, "WebRTC signaling role mismatch")
        return
      }
      if (role === "viewer") BrowserWebRTCSignaling.handleViewerMessage(state.owner, pageId, ws, message)
      else BrowserWebRTCSignaling.handleHostMessage(state.owner, pageId, message)
    },
    onClose() {
      if (!pageId || !socket) return
      if (role === "viewer") BrowserWebRTCSignaling.detachViewer(state.owner, pageId, socket)
      else BrowserWebRTCSignaling.detachHost(state.owner, pageId, socket)
    },
  }
}

function assertWebSocketRequest(c: any, role: "viewer" | "host"): void {
  if (c.req.query("protocolVersion") !== String(BROWSER_PROTOCOL_VERSION)) {
    throw new BrowserProtocolError({
      code: "browser_protocol_mismatch",
      message: `Browser protocol ${BROWSER_PROTOCOL_VERSION} is required.`,
      retryable: false,
    })
  }
  const origin = c.req.header("origin")
  if (role === "host") {
    if (origin) throw new Error("Browser Host connections must not originate from a web page.")
    return
  }
  if (!origin) throw new Error("Browser viewer connections require an Origin header.")
  if (origin === "file://") return
  const requestURL = new URL(c.req.url)
  if (origin === requestURL.origin) return
  const parsed = new URL(origin)
  if (isLoopback(parsed.hostname) && isLoopback(requestURL.hostname)) return
  const allowed = new Set(
    (process.env.SYNERGY_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  )
  if (!allowed.has(origin)) throw new Error(`Browser viewer Origin is not allowed: ${origin}`)
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
}

function browserIceServers() {
  const value = process.env.SYNERGY_BROWSER_ICE_SERVERS
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry) => BrowserViewerTicketResponseSchema.shape.iceServers.element.safeParse(entry).success)
  } catch {
    return []
  }
}

async function diagnosticsData(
  owner: BrowserOwner.Info,
  body: z.infer<typeof BrowserDiagnosticsRequestSchema>,
): Promise<unknown> {
  if (body.action === "downloads") {
    return BrowserDownloads.list(owner).map((record) => ({
      id: record.id,
      url: record.url,
      fileName: record.suggestedFilename,
      mimeType: record.mimeType ?? "application/octet-stream",
      state: record.state === "pending" ? "in_progress" : record.state === "failed" ? "interrupted" : record.state,
      totalBytes: record.size ?? 0,
      receivedBytes: record.size ?? 0,
      timestamp: record.createdAt,
      warning: record.state === "blocked" ? "Download blocked by Browser safety policy." : undefined,
    }))
  }
  if (body.action === "clear") {
    await BrowserCommandService.execute(owner, {
      commandId: `${body.commandId}:console`,
      command: { type: "console", action: "clear" },
    })
    await BrowserCommandService.execute(owner, {
      commandId: `${body.commandId}:network`,
      command: { type: "network", action: "clear" },
    })
    return { cleared: true }
  }
  if (body.action === "elements") {
    const result = await BrowserCommandService.execute(owner, {
      commandId: body.commandId,
      command: { type: "snapshot", maxNodes: body.limit },
    })
    return result.type === "snapshot" ? result.elements.map((element) => ({ ...element, children: [] })) : []
  }
  const result = await BrowserCommandService.execute(owner, {
    commandId: body.commandId,
    command:
      body.action === "console"
        ? { type: "console", action: "list", page: 0, pageSize: body.limit }
        : { type: "network", action: "list", page: 0, pageSize: body.limit },
  })
  const data = result.type === "data" && result.data && typeof result.data === "object" ? result.data : {}
  if (body.action === "console") return (data as { entries?: unknown[] }).entries ?? []
  const requests = (data as { requests?: Array<Record<string, unknown>> }).requests ?? []
  if (body.action === "network") return requests
  return requests.map((request) => {
    const headers = request.responseHeaders as Record<string, string> | undefined
    const mimeType = headers?.["content-type"] ?? headers?.["Content-Type"] ?? ""
    return {
      id: String(request.id ?? ""),
      pageID: body.pageId,
      url: String(request.url ?? ""),
      type: BrowserAssets.classifyByMime(mimeType),
      mimeType: mimeType || undefined,
      status: typeof request.status === "number" ? request.status : undefined,
    }
  })
}

function rejectedSocket(error: unknown) {
  return {
    onOpen(_event: unknown, ws: BrowserWS) {
      send(ws, protocolError(error, "browser_route_failed"))
      ws.close(1008, "Invalid Browser route")
    },
    onMessage() {},
    onClose() {},
  }
}

function protocolError(error: unknown, code: string, commandId?: string) {
  return BrowserProtocolError.from(error, {
    code,
    message: error instanceof Error ? error.message : "Browser request failed.",
    retryable: false,
    ...(commandId ? { commandId } : {}),
  }).toJSON()
}

function limitBrowserBody(maxBytes: number) {
  return async (c: Context, next: Next) => {
    const declared = Number(c.req.header("content-length") ?? 0)
    if (Number.isFinite(declared) && declared > maxBytes) {
      return c.json(protocolError(new Error("Browser request payload is too large."), "browser_payload_too_large"), 413)
    }
    if (!(await requestWithinLimit(c.req.raw, maxBytes))) {
      return c.json(protocolError(new Error("Browser request payload is too large."), "browser_payload_too_large"), 413)
    }
    await next()
  }
}

async function requestWithinLimit(request: Request, maxBytes: number): Promise<boolean> {
  const body = request.clone().body
  if (!body) return true
  const reader = body.getReader()
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return true
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return false
      }
    }
  } finally {
    reader.releaseLock()
  }
}
