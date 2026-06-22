import { Hono } from "hono"
import { upgradeWebSocket } from "hono/bun"
import { Log } from "../util/log"

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

    log.info("browser WebSocket connected", { directory })

    return {
      onOpen(_event, _ws) {
        // Connection established. Full integration with BrowserRuntime
        // + frontend panel in Phase 4.
      },
      onMessage(event, _ws) {
        try {
          const msg = JSON.parse(event.data as string)
          log.debug("browser WS message", { type: msg.type, directory })
          // Messages forwarded to BrowserRuntime in Phase 4
        } catch {
          // silently ignore parse errors
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
