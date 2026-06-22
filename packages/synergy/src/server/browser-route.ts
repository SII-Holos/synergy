import type { BrowserSession } from "../browser/session.js"
import { Hono } from "hono"
import { upgradeWebSocket } from "hono/bun"
import { Log } from "../util/log"
import { BrowserOwner } from "../browser/owner.js"
import { BrowserRuntime } from "../browser/runtime.js"
import { Instance } from "../scope/instance"

const log = Log.create({ service: "browser.route" })

export const BrowserRoute = new Hono().get(
  "/:directory/browser/connect",
  upgradeWebSocket((c) => {
    const directory = c.req.param("directory")
    if (!directory) {
      return {
        onOpen(_event, ws) {
          ws.close(1008, "Missing directory")
        },
        onMessage() {},
        onClose() {},
      }
    }

    // Validate same-origin
    const origin = c.req.header("origin")
    const host = c.req.header("host")
    if (origin && host && !isSameOrigin(origin, host)) {
      log.warn("browser WS rejected: cross-origin", { origin, host })
      return {
        onOpen(_event, ws) {
          ws.close(1008, "Cross-origin not allowed")
        },
        onMessage() {},
        onClose() {},
      }
    }

    const mode = (c.req.query("mode") ?? "session") as BrowserOwner.Mode
    const sessionID = c.req.query("sessionID")

    // Resolve scopeID from the request-scoped Instance (set by provideRequestScope middleware).
    // The upgrade callback runs inside the middleware chain, so Instance.scope is available.
    const scopeID = Instance.scope.id

    const owner = BrowserOwner.fromRoute({
      directory: Instance.directory,
      scopeID,
      sessionID,
      mode,
    })
    BrowserOwner.assertValid(owner)

    log.info("browser WebSocket connected", { directory, ownerKey: BrowserOwner.key(owner) })

    return {
      onOpen: async (_event, ws) => {
        try {
          await BrowserRuntime.ensure()
          const session = (await BrowserRuntime.getOrCreateSession(owner)) as BrowserSession
          const tabs = session.tabs.map((t) => ({ id: t.id, url: t.url, title: t.title }))
          ws.send(
            JSON.stringify({
              type: "session.state",
              tabs,
              activeTabId: session.activeTab?.id ?? null,
            }),
          )
        } catch (e: any) {
          log.error("browser WS onOpen error", { error: e?.message ?? String(e) })
          ws.send(JSON.stringify({ type: "error", message: e?.message ?? "Failed to open browser session" }))
        }
      },
      onMessage: async (event, ws) => {
        let msg: any
        try {
          msg = JSON.parse(event.data as string)
        } catch {
          return
        }

        try {
          const session = (await BrowserRuntime.getOrCreateSession(owner)) as BrowserSession

          switch (msg.type) {
            case "navigate": {
              const tab = session.activeTab
              if (!tab) {
                ws.send(JSON.stringify({ type: "error", message: "No active tab" }))
                return
              }
              await tab.navigate(msg.url)
              ws.send(
                JSON.stringify({
                  type: "tab.navigated",
                  tabId: tab.id,
                  url: tab.url,
                  title: tab.title,
                }),
              )
              try {
                const shot = await tab.screenshot()
                ws.send(
                  JSON.stringify({
                    type: "screenshot",
                    tabId: tab.id,
                    dataUrl: `data:image/png;base64,${shot.buffer.toString("base64")}`,
                    width: shot.width,
                    height: shot.height,
                  }),
                )
              } catch {
                /* screenshot may fail */
              }
              break
            }
            case "click": {
              const tab = session.activeTab
              if (!tab) break
              await tab.click(msg.x, msg.y)
              try {
                const shot = await tab.screenshot()
                ws.send(
                  JSON.stringify({
                    type: "screenshot",
                    tabId: tab.id,
                    dataUrl: `data:image/png;base64,${shot.buffer.toString("base64")}`,
                    width: shot.width,
                    height: shot.height,
                  }),
                )
              } catch {
                /* screenshot may fail */
              }
              break
            }
            case "type": {
              const tab = session.activeTab
              if (!tab) break
              await tab.type(msg.text)
              break
            }
            case "scroll": {
              const tab = session.activeTab
              if (!tab) break
              await tab.scroll(msg.deltaX ?? 0, msg.deltaY ?? 0)
              break
            }
            case "createTab": {
              const tab = await session.createTab(msg.url)
              ws.send(
                JSON.stringify({
                  type: "tab.created",
                  tab: { id: tab.id, url: tab.url, title: tab.title },
                  active: !session.activeTab || session.activeTab === tab,
                }),
              )
              break
            }
            case "closeTab": {
              await session.closeTab(msg.tabId)
              ws.send(JSON.stringify({ type: "tab.closed", tabId: msg.tabId }))
              break
            }
            case "switchTab": {
              session.switchTab(msg.tabId)
              break
            }
            case "reload": {
              const tab = msg.tabId ? session.getTab(msg.tabId) : session.activeTab
              if (tab) await tab.reload()
              break
            }
            case "requestScreenshot": {
              const tab = msg.tabId ? session.getTab(msg.tabId) : session.activeTab
              if (!tab) break
              try {
                const shot = await tab.screenshot("png", undefined, msg.fullPage)
                ws.send(
                  JSON.stringify({
                    type: "screenshot",
                    tabId: tab.id,
                    dataUrl: `data:image/png;base64,${shot.buffer.toString("base64")}`,
                    width: shot.width,
                    height: shot.height,
                  }),
                )
              } catch {
                /* screenshot may fail */
              }
              break
            }
            case "requestSnapshot": {
              const tab = msg.tabId ? session.getTab(msg.tabId) : session.activeTab
              if (!tab) break
              const snap = await tab.snapshot()
              ws.send(
                JSON.stringify({
                  type: "snapshot",
                  tabId: tab.id,
                  elements: snap.elements,
                }),
              )
              break
            }
            case "requestConsole": {
              const tab = msg.tabId ? session.getTab(msg.tabId) : session.activeTab
              if (!tab) break
              const entries = await tab.consoleEntries(msg.maxEntries ?? 50)
              ws.send(
                JSON.stringify({
                  type: "console",
                  tabId: tab.id,
                  entries,
                }),
              )
              break
            }
            case "requestNetwork": {
              const tab = msg.tabId ? session.getTab(msg.tabId) : session.activeTab
              if (!tab) break
              const requests = await tab.networkRequests(msg.maxEntries ?? 20)
              ws.send(
                JSON.stringify({
                  type: "network",
                  tabId: tab.id,
                  requests,
                }),
              )
              break
            }
            case "createAnnotation": {
              const ann = session.addAnnotation({
                comment: msg.comment,
                styleFeedback: msg.styleFeedback,
                createdBy: "user",
                tabID: msg.tabId,
              })
              ws.send(
                JSON.stringify({
                  type: "annotation.created",
                  annotation: ann,
                }),
              )
              break
            }
            default:
              log.debug("browser WS unknown message type", { type: msg.type })
          }
        } catch (e: any) {
          log.error("browser WS dispatch error", { error: e?.message ?? String(e) })
          ws.send(JSON.stringify({ type: "error", message: e?.message ?? "Browser operation failed" }))
        }
      },
      onClose(_event, _ws) {
        log.info("browser WebSocket disconnected", { directory })
      },
      onError(event, _ws) {
        log.warn("browser WebSocket error", { directory, error: String(event) })
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
