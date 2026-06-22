import type { BrowserTab } from "../browser/tab.js"
import { Hono } from "hono"
import { upgradeWebSocket } from "hono/bun"
import { Log } from "../util/log"
import { BrowserOwner } from "../browser/owner.js"
import { BrowserRuntime } from "../browser/runtime.js"
import { Instance } from "../scope/instance"

const log = Log.create({ service: "browser.route" })

interface BrowserWS {
  send(data: string): void
  close(code?: number, reason?: string): void
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
    let unsubscribe: (() => void) | undefined = undefined

    log.info("browser WebSocket connected", { directory, ownerKey: BrowserOwner.key(owner) })

    function s(ws: BrowserWS, payload: Record<string, unknown>) {
      ws.send(JSON.stringify(payload))
    }

    async function sendBrowserScreenshot(ws: BrowserWS, tab: BrowserTab, reason: string) {
      try {
        const shot = await tab.screenshot()
        s(ws, {
          type: "screenshot",
          tabId: tab.id,
          dataUrl: `data:image/png;base64,${shot.buffer.toString("base64")}`,
          width: shot.width,
          height: shot.height,
        })
      } catch (e: any) {
        log.warn("browser screenshot failed", { reason, error: e?.message ?? String(e) })
        s(ws, { type: "error", message: "Screenshot failed" })
      }
    }

    return {
      onOpen: async (_e: any, ws: BrowserWS) => {
        try {
          await BrowserRuntime.ensure()
          const session = await BrowserRuntime.getOrCreateSession(owner)
          const tabs = session.tabs.map((t) => ({ id: t.id, url: t.url, title: t.title }))
          s(ws, { type: "session.state", tabs, activeTabId: session.activeTab?.id ?? null })

          // Auto-create initial tab if session is empty
          if (session.tabs.length === 0) {
            const tab = await session.createTab()
            s(ws, {
              type: "tab.created",
              tab: { id: tab.id, url: tab.url, title: tab.title },
              active: session.activeTab === tab,
            })
          }

          // Subscribe to session changes for agent tool sync
          unsubscribe = session.addObserver({
            onTabCreated: (tab) => {
              s(ws, {
                type: "tab.created",
                tab: { id: tab.id, url: tab.url, title: tab.title },
                active: session.activeTab === tab,
              })
            },
            onTabClosed: (tabID) => {
              s(ws, { type: "tab.closed", tabId: tabID })
            },
            onTabNavigated: (tab) => {
              s(ws, { type: "tab.navigated", tabId: tab.id, url: tab.url, title: tab.title })
              sendBrowserScreenshot(ws, tab, "agent-navigate").catch(() => {})
            },
          })
        } catch (e: any) {
          log.error("browser WS onOpen error", { error: e?.message ?? String(e) })
          s(ws, { type: "error", message: e?.message ?? "Failed to open browser session" })
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
              const tab = session.activeTab
              if (!tab) {
                s(ws, { type: "error", message: "No active tab" })
                return
              }
              await tab.navigate(msg.url)
              s(ws, { type: "tab.navigated", tabId: tab.id, url: tab.url, title: tab.title })
              await sendBrowserScreenshot(ws, tab, "navigate")
              break
            }
            case "click": {
              const tab = session.activeTab
              if (!tab) break
              await tab.click(msg.x, msg.y)
              await sendBrowserScreenshot(ws, tab, "click")
              break
            }
            case "type": {
              const tab = session.activeTab
              if (!tab) break
              await tab.type(msg.text)
              await sendBrowserScreenshot(ws, tab, "type")
              break
            }
            case "scroll": {
              const tab = session.activeTab
              if (!tab) break
              await tab.scroll(msg.deltaX ?? 0, msg.deltaY ?? 0)
              await sendBrowserScreenshot(ws, tab, "scroll")
              break
            }
            case "createTab": {
              const tab = await session.createTab(msg.url)
              s(ws, {
                type: "tab.created",
                tab: { id: tab.id, url: tab.url, title: tab.title },
                active: !session.activeTab || session.activeTab === tab,
              })
              break
            }
            case "closeTab": {
              await session.closeTab(msg.tabId)
              s(ws, { type: "tab.closed", tabId: msg.tabId })
              break
            }
            case "switchTab": {
              session.switchTab(msg.tabId)
              if (session.activeTab) await sendBrowserScreenshot(ws, session.activeTab, "switchTab")
              break
            }
            case "reload": {
              const tab = msg.tabId ? session.getTab(msg.tabId) : session.activeTab
              if (tab) {
                await tab.reload()
                await sendBrowserScreenshot(ws, tab, "reload")
              }
              break
            }
            case "requestScreenshot": {
              const tab = msg.tabId ? session.getTab(msg.tabId) : session.activeTab
              if (!tab) break
              await sendBrowserScreenshot(ws, tab, "requestScreenshot")
              break
            }
            case "requestSnapshot": {
              const tab = msg.tabId ? session.getTab(msg.tabId) : session.activeTab
              if (!tab) break
              const snap = await tab.snapshot()
              s(ws, { type: "snapshot", tabId: tab.id, elements: snap.elements })
              break
            }
            case "requestConsole": {
              const tab = msg.tabId ? session.getTab(msg.tabId) : session.activeTab
              if (!tab) break
              const entries = await tab.consoleEntries(msg.maxEntries ?? 50)
              s(ws, { type: "console", tabId: tab.id, entries })
              break
            }
            case "requestNetwork": {
              const tab = msg.tabId ? session.getTab(msg.tabId) : session.activeTab
              if (!tab) break
              const requests = await tab.networkRequests(msg.maxEntries ?? 20)
              s(ws, { type: "network", tabId: tab.id, requests })
              break
            }
            case "createAnnotation": {
              const ann = session.addAnnotation({
                comment: msg.comment,
                styleFeedback: msg.styleFeedback,
                createdBy: "user",
                tabID: msg.tabId,
              })
              s(ws, { type: "annotation.created", annotation: ann })
              break
            }
            default:
              log.debug("browser WS unknown message type", { type: msg.type })
          }
        } catch (e: any) {
          log.error("browser WS dispatch error", { error: e?.message ?? String(e) })
          s(ws, { type: "error", message: e?.message ?? "Browser operation failed" })
        }
      },
      onClose(_e: any, _ws: BrowserWS) {
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
