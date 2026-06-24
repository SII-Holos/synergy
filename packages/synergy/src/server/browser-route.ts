import type { BrowserSession } from "../browser/types.js"
import type { BrowserTab, BrowserUploadFile } from "../browser/tab.js"
import { Hono } from "hono"
import { upgradeWebSocket } from "hono/bun"
import { Log } from "../util/log"
import { BrowserOwner } from "../browser/owner.js"
import { BrowserRuntime } from "../browser/runtime.js"
import { BrowserAssets } from "../browser/assets.js"
import { Instance } from "../scope/instance"

const log = Log.create({ service: "browser.route" })

interface BrowserWS {
  send(data: string): void
  close(code?: number, reason?: string): void
}

function tabPayload(tab: BrowserTab) {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    isLoading: tab.loading,
    pinned: tab.pinned,
    kept: tab.kept,
    lastActiveAt: tab.lastActiveAt,
  }
}

function sessionPayload(session: BrowserSession, runtimeHealth?: Awaited<ReturnType<typeof BrowserRuntime.health>>) {
  return {
    type: "session.state",
    tabs: session.tabs.map(tabPayload),
    activeTabId: session.activeTab?.id ?? null,
    connection: { status: "connected" },
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

function resolveTab(session: BrowserSession, tabId?: string): BrowserTab | null {
  if (tabId) return session.getTab(tabId) ?? null
  return session.activeTab
}

export const BrowserRoute = new Hono().get(
  "/:directory/browser/connect",
  upgradeWebSocket((c) => {
    const directory = c.req.param("directory")
    if (!directory) {
      return {
        onOpen(_e: any, ws: BrowserWS) {
          ws.close(1008, "Missing directory")
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

    const mode = (c.req.query("mode") ?? "session") as BrowserOwner.Mode
    const sessionID = c.req.query("sessionID")
    const scopeID = Instance.scope.id
    const owner = BrowserOwner.fromRoute({ directory: Instance.directory, scopeID, sessionID, mode })
    BrowserOwner.assertValid(owner)

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

    log.info("browser WebSocket connected", { directory, ownerKey: BrowserOwner.key(owner) })

    return {
      onOpen: async (_e: any, ws: BrowserWS) => {
        try {
          await BrowserRuntime.ensure()
          const session = await BrowserRuntime.getOrCreateSession(owner)
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

          if (session.tabs.length === 0) {
            await session.createTab()
          }
          send(ws, sessionPayload(session, await BrowserRuntime.health()))
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
          const session = await BrowserRuntime.getOrCreateSession(owner)
          switch (msg.type) {
            case "navigate": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) throw new Error("No active tab")
              await tab.navigateForUser(String(msg.url ?? ""))
              await session.save()
              break
            }
            case "reload": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) throw new Error("No active tab")
              await tab.reload()
              await session.save()
              break
            }
            case "stop": {
              const tab = resolveTab(session, msg.tabId)
              if (tab) await tab.stop()
              break
            }
            case "history": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) throw new Error("No active tab")
              if (msg.direction === "back") await tab.goBack()
              if (msg.direction === "forward") await tab.goForward()
              await session.save()
              break
            }
            case "createTab": {
              const tab = await session.createTab()
              session.switchTab(tab.id)
              if (msg.url) {
                await tab.navigateForUser(String(msg.url))
                await session.save()
              }
              send(ws, { type: "tab.activated", tabId: tab.id, tab: tabPayload(tab) })
              await startStream(ws, session, tab)
              break
            }
            case "closeTab": {
              if (msg.tabId === streamedTabId) await stopStream(session, msg.tabId)
              await session.closeTab(String(msg.tabId))
              break
            }
            case "switchTab": {
              session.switchTab(String(msg.tabId))
              const tab = session.activeTab
              if (tab) await startStream(ws, session, tab)
              break
            }
            case "stream.start": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) throw new Error("No active tab")
              await startStream(ws, session, tab)
              break
            }
            case "stream.stop": {
              await stopStream(session, msg.tabId)
              send(ws, { type: "stream.stopped", tabId: msg.tabId ?? streamedTabId })
              break
            }
            case "input.resize": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) throw new Error("No active tab")
              await tab.setViewport(Number(msg.width), Number(msg.height), Number(msg.deviceScaleFactor ?? 1))
              send(ws, { type: "tab.updated", tab: tabPayload(tab) })
              break
            }
            case "input.mouse": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) throw new Error("No active tab")
              await tab.dispatchMouse(msg.action, msg)
              break
            }
            case "input.key": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) throw new Error("No active tab")
              await tab.dispatchKey(msg.action, msg)
              break
            }
            case "input.text": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) throw new Error("No active tab")
              await tab.insertText(String(msg.text ?? ""))
              break
            }
            case "requestConsole": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) break
              send(ws, {
                type: "console.entries",
                tabId: tab.id,
                entries: await tab.consoleEntries(msg.maxEntries ?? 50),
              })
              break
            }
            case "requestNetwork": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) break
              send(ws, {
                type: "network.entries",
                tabId: tab.id,
                requests: await tab.networkRequests(msg.maxEntries ?? 100),
              })
              break
            }
            case "requestSnapshot": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) break
              const snap = await tab.snapshot()
              send(ws, { type: "snapshot.result", tabId: tab.id, elements: snap.elements, truncated: snap.truncated })
              break
            }
            case "requestAssets": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) break
              const requests = await tab.networkRequests(msg.maxEntries ?? 200)
              send(ws, {
                type: "assets.entries",
                tabId: tab.id,
                assets: BrowserAssets.fromNetworkBuffer(requests, tab.id),
              })
              break
            }
            case "requestScreenshot": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) break
              const shot = await tab.screenshot()
              send(ws, {
                type: "screenshot",
                tabId: tab.id,
                dataUrl: `data:image/png;base64,${shot.buffer.toString("base64")}`,
                width: shot.width,
                height: shot.height,
              })
              break
            }
            case "filechooser.select": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) throw new Error("No active tab")
              await tab.respondToFileChooser(String(msg.requestId), (msg.files ?? []) as BrowserUploadFile[])
              break
            }
            case "dialog.respond": {
              const tab = resolveTab(session, msg.tabId)
              if (!tab) throw new Error("No active tab")
              await tab.respondToDialog(String(msg.requestId), Boolean(msg.accept), msg.promptText)
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
              const tab = resolveTab(session, msg.tabId)
              if (!tab) break
              await tab.clearDiagnostics()
              send(ws, { type: "diagnostics.cleared", tabId: tab.id })
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
          const session = await BrowserRuntime.getOrCreateSession(owner)
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
