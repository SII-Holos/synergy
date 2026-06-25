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
import { BrowserHost } from "../browser/host.js"
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

function send(ws: BrowserWS, payload: Record<string, unknown>) {
  try {
    ws.send(JSON.stringify(payload))
  } catch {
    // The socket may have closed between async browser events.
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
    "/:directory/browser/webrtc/connect",
    upgradeWebSocket((c) => {
      let state: BrowserRouteState
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

      return {
        onOpen: async (_e: any, ws: BrowserWS) => {
          const session = await ensureSession(state.owner, { createInitialTab: true })
          send(ws, {
            type: "webrtc.signaling.ready",
            presentation: state.presentation,
            session: BrowserControl.sessionState(session),
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

          if (msg.type === "webrtc.close") {
            send(ws, { type: "webrtc.closed", tabId: msg.tabId })
            return
          }

          send(ws, {
            type: "webrtc.host.pending",
            tabId: msg.tabId,
            code: "browser_webrtc_host_not_attached",
            message: "WebRTC signaling is available; Electron Browser Host media transport is not attached yet.",
          })
        },
        onClose() {},
      }
    }),
  )
  .get(
    "/:directory/browser/connect",
    upgradeWebSocket((c) => {
      let state: BrowserRouteState
      try {
        state = routeState(c)
      } catch (e: any) {
        return {
          onOpen(_e: any, ws: BrowserWS) {
            send(ws, { type: "error", code: "browser_route_failed", message: e?.message ?? String(e) })
            ws.close(1008, "Invalid browser route")
          },
          onMessage() {},
          onClose() {},
        }
      }

      const origin = c.req.header("origin")
      const host = c.req.header("host")
      if (origin && host && !isSameOrigin(origin, host)) {
        log.warn("browser WS rejected: cross-origin", { origin, host })
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
      let streamedTabId: string | null = null

      async function stopStream(session: BrowserSession, tabId?: string) {
        const id = tabId ?? streamedTabId
        if (!id) return
        const tab = session.getTab(id)
        if (tab) await tab.stopFrameStream()
        streamedTabId = streamedTabId === id ? null : streamedTabId
      }

      async function startStream(ws: BrowserWS, session: BrowserSession, tab: BrowserTab) {
        if (streamedTabId && streamedTabId !== tab.id) {
          await stopStream(session, streamedTabId)
        }
        streamedTabId = tab.id
        send(ws, { type: "stream.started", tabId: tab.id, format: "jpeg", quality: 70 })
        await tab.startFrameStream({ format: "jpeg", quality: 70, fps: 20 }, (frame) => {
          send(ws, { type: "frame", ...frame })
        })
      }

      log.info("browser WebSocket connected", {
        directory,
        ownerKey: BrowserOwner.key(owner),
        presentation: presentation.kind,
        presentationReason: presentation.reason,
      })

      return {
        onOpen: async (_e: any, ws: BrowserWS) => {
          try {
            const session = await ensureSession(owner, { createInitialTab: true })
            unsubscribe = session.addObserver({
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

            send(ws, sessionPayload(session, presentation, await BrowserHost.health()))
          } catch (e: any) {
            log.error("browser WS onOpen error", { error: e?.message ?? String(e) })
            send(ws, {
              type: "error",
              severity: "critical",
              code: "browser_open_failed",
              message: e?.message ?? "Failed to open browser session",
            })
            ws.close(1011, "Failed to open browser session")
          }
        },
        onMessage: async (event: any, ws: BrowserWS) => {
          let msg: any
          try {
            msg = JSON.parse(event.data as string)
          } catch (e) {
            log.warn("browser WS invalid message", { error: String(e) })
            return
          }

          try {
            const session = await ensureSession(owner)
            switch (msg.type) {
              case "navigate": {
                await BrowserHost.execute(owner, {
                  type: "navigate",
                  source: "user",
                  tabId: msg.tabId,
                  url: String(msg.url ?? ""),
                })
                break
              }
              case "reload": {
                await BrowserHost.execute(owner, { type: "reload", tabId: msg.tabId })
                break
              }
              case "stop": {
                await BrowserHost.execute(owner, { type: "stop", tabId: msg.tabId })
                break
              }
              case "history": {
                if (msg.direction !== "back" && msg.direction !== "forward") break
                await BrowserHost.execute(owner, {
                  type: "history",
                  tabId: msg.tabId,
                  direction: msg.direction,
                })
                break
              }
              case "createTab": {
                const created = await BrowserHost.execute(owner, { type: "createTab" })
                if (created.type !== "tab") break
                const tab = BrowserControl.resolveTab(session, created.tab.id)
                if (msg.url) {
                  await BrowserHost.execute(owner, {
                    type: "navigate",
                    source: "user",
                    tabId: tab.id,
                    url: String(msg.url),
                  })
                }
                send(ws, { type: "tab.activated", tabId: tab.id, tab: tabPayload(tab) })
                await startStream(ws, session, tab)
                break
              }
              case "closeTab": {
                if (msg.tabId === streamedTabId) await stopStream(session, msg.tabId)
                await BrowserHost.execute(owner, { type: "closeTab", tabId: String(msg.tabId) })
                break
              }
              case "switchTab": {
                const result = await BrowserHost.execute(owner, { type: "switchTab", tabId: String(msg.tabId) })
                if (result.type === "tab")
                  await startStream(ws, session, BrowserControl.resolveTab(session, result.tab.id))
                break
              }
              case "stream.start": {
                const tab = BrowserControl.resolveTab(session, msg.tabId)
                await startStream(ws, session, tab)
                break
              }
              case "stream.stop": {
                await stopStream(session, msg.tabId)
                send(ws, { type: "stream.stopped", tabId: msg.tabId ?? streamedTabId })
                break
              }
              case "input.resize": {
                const result = await BrowserHost.execute(owner, {
                  type: "setViewport",
                  tabId: msg.tabId,
                  width: Number(msg.width),
                  height: Number(msg.height),
                  deviceScaleFactor: Number(msg.deviceScaleFactor ?? 1),
                })
                if (result.type === "tab") send(ws, { type: "tab.updated", tab: result.tab })
                break
              }
              case "input.mouse": {
                if (msg.action !== "move" && msg.action !== "down" && msg.action !== "up" && msg.action !== "wheel")
                  break
                await BrowserHost.execute(owner, {
                  type: "mouse",
                  tabId: msg.tabId,
                  action: msg.action,
                  input: msg,
                })
                break
              }
              case "input.key": {
                if (msg.action !== "down" && msg.action !== "up") break
                await BrowserHost.execute(owner, {
                  type: "key",
                  tabId: msg.tabId,
                  action: msg.action,
                  input: msg,
                })
                break
              }
              case "input.text": {
                await BrowserHost.execute(owner, {
                  type: "insertText",
                  tabId: msg.tabId,
                  text: String(msg.text ?? ""),
                })
                break
              }
              case "requestConsole": {
                const result = await BrowserHost.execute(owner, {
                  type: "console",
                  tabId: msg.tabId,
                  maxEntries: msg.maxEntries,
                })
                if (result.type === "console") {
                  send(ws, { type: "console.entries", tabId: result.tabId, entries: result.entries })
                }
                break
              }
              case "requestNetwork": {
                const result = await BrowserHost.execute(owner, {
                  type: "network",
                  tabId: msg.tabId,
                  maxEntries: msg.maxEntries,
                })
                if (result.type === "network") {
                  send(ws, { type: "network.entries", tabId: result.tabId, requests: result.requests })
                }
                break
              }
              case "requestSnapshot": {
                const result = await BrowserHost.execute(owner, { type: "snapshot", tabId: msg.tabId })
                if (result.type === "snapshot") {
                  send(ws, {
                    type: "snapshot.result",
                    tabId: result.tabId,
                    elements: result.elements,
                    truncated: result.truncated,
                  })
                }
                break
              }
              case "requestAssets": {
                const result = await BrowserHost.execute(owner, {
                  type: "assets",
                  tabId: msg.tabId,
                  maxEntries: msg.maxEntries,
                })
                if (result.type === "assets") {
                  send(ws, { type: "assets.entries", tabId: result.tabId, assets: result.assets })
                }
                break
              }
              case "requestScreenshot": {
                const result = await BrowserHost.execute(owner, { type: "screenshot", tabId: msg.tabId })
                if (result.type === "screenshot") send(ws, result)
                break
              }
              case "filechooser.select": {
                await BrowserHost.execute(owner, {
                  type: "filechooser.select",
                  tabId: msg.tabId,
                  requestId: String(msg.requestId),
                  files: msg.files ?? [],
                })
                break
              }
              case "dialog.respond": {
                await BrowserHost.execute(owner, {
                  type: "dialog.respond",
                  tabId: msg.tabId,
                  requestId: String(msg.requestId),
                  accept: Boolean(msg.accept),
                  promptText: msg.promptText,
                })
                break
              }
              case "createAnnotation": {
                const ann = session.addAnnotation({
                  comment: msg.comment,
                  styleFeedback: msg.styleFeedback,
                  createdBy: "user",
                  tabID: msg.tabId,
                })
                send(ws, { type: "annotation.created", annotation: ann })
                break
              }
              case "setFollowAgent":
              case "followAgentNow":
                break
              case "clearLogs": {
                const result = await BrowserHost.execute(owner, { type: "clearDiagnostics", tabId: msg.tabId })
                if (result.type === "diagnostics.cleared") send(ws, result)
                break
              }
              default:
                log.debug("browser WS unknown message type", { type: msg.type })
            }
          } catch (e: any) {
            log.error("browser WS dispatch error", { type: msg.type, error: e?.message ?? String(e) })
            send(ws, {
              type: "error",
              severity: "error",
              code: "browser_operation_failed",
              message: e?.message ?? "Browser operation failed",
            })
          }
        },
        onClose: async (_e: any, _ws: BrowserWS) => {
          try {
            const session = await ensureSession(owner)
            await stopStream(session)
          } catch {
            // ignore close cleanup errors
          }
          unsubscribe?.()
          log.info("browser WebSocket disconnected")
        },
        onError(_e: any, _ws: BrowserWS) {
          log.warn("browser WebSocket error", { error: String(_e) })
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
