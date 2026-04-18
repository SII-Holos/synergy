import { Log } from "../util/log"
import { OAUTH_CALLBACK_PATH, getOAuthCallbackPort } from "./oauth-provider"

const log = Log.create({ service: "mcp.oauth-callback" })

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>Synergy - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to Synergy.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html>
<head>
  <title>Synergy - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${error}</div>
  </div>
</body>
</html>`

interface PendingAuth {
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export namespace McpOAuthCallback {
  let server: ReturnType<typeof Bun.serve> | undefined
  const pendingAuths = new Map<string, PendingAuth>()

  const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
  const PORT_WAIT_TIMEOUT_MS = 1_000
  const PORT_WAIT_INTERVAL_MS = 25

  async function waitForPortInUse(expected: boolean, timeoutMs = PORT_WAIT_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await isPortInUse()) === expected) {
        return true
      }
      await Bun.sleep(PORT_WAIT_INTERVAL_MS)
    }
    return (await isPortInUse()) === expected
  }

  function callbackPort(): number {
    return getOAuthCallbackPort()
  }

  export async function ensureRunning(): Promise<void> {
    if (server) return

    const port = getOAuthCallbackPort()
    const portFreed = await waitForPortInUse(false)
    if (!portFreed) {
      throw new Error(`OAuth callback port ${port} is already in use`)
    }

    server = Bun.serve({
      port,
      fetch(req) {
        const url = new URL(req.url)

        if (url.pathname !== OAUTH_CALLBACK_PATH) {
          return new Response("Not found", { status: 404 })
        }

        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        const error = url.searchParams.get("error")
        const errorDescription = url.searchParams.get("error_description")

        log.info("received oauth callback", { hasCode: !!code, hasError: !!error })

        // Enforce state parameter presence
        if (!state) {
          const errorMsg = "Missing required state parameter - potential CSRF attack"
          log.error("oauth callback missing state parameter", { path: url.pathname })
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        if (error) {
          const errorMsg = errorDescription || error
          if (pendingAuths.has(state)) {
            const pending = pendingAuths.get(state)!
            clearTimeout(pending.timeout)
            pendingAuths.delete(state)
            pending.reject(new Error(errorMsg))
          }
          return new Response(HTML_ERROR(errorMsg), {
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!code) {
          return new Response(HTML_ERROR("No authorization code provided"), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        // Validate state parameter
        if (!pendingAuths.has(state)) {
          const errorMsg = "Invalid or expired state parameter - potential CSRF attack"
          log.error("oauth callback with invalid state", { pendingCount: pendingAuths.size })
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        const pending = pendingAuths.get(state)!

        clearTimeout(pending.timeout)
        pendingAuths.delete(state)
        pending.resolve(code)

        return new Response(HTML_SUCCESS, {
          headers: { "Content-Type": "text/html" },
        })
      },
    })

    log.info("oauth callback server started", { port: callbackPort() })
  }

  export function waitForCallback(oauthState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pendingAuths.has(oauthState)) {
          pendingAuths.delete(oauthState)
          reject(new Error("OAuth callback timeout - authorization took too long"))
        }
      }, CALLBACK_TIMEOUT_MS)

      pendingAuths.set(oauthState, { resolve, reject, timeout })
    })
  }

  export function cancelPending(mcpName: string): void {
    const pending = pendingAuths.get(mcpName)
    if (pending) {
      clearTimeout(pending.timeout)
      pendingAuths.delete(mcpName)
      pending.reject(new Error("Authorization cancelled"))
    }
  }

  export async function isPortInUse(): Promise<boolean> {
    return new Promise((resolve) => {
      Bun.connect({
        hostname: "127.0.0.1",
        port: callbackPort(),
        socket: {
          open(socket) {
            socket.end()
            resolve(true)
          },
          error() {
            resolve(false)
          },
          data() {},
          close() {},
        },
      }).catch(() => {
        resolve(false)
      })
    })
  }

  export async function stop(): Promise<void> {
    if (server) {
      server.stop()
      server = undefined
      await waitForPortInUse(false)
      log.info("oauth callback server stopped")
    }

    for (const [name, pending] of pendingAuths) {
      clearTimeout(pending.timeout)
      pending.reject(new Error("OAuth callback server stopped"))
    }
    pendingAuths.clear()
  }

  export function isRunning(): boolean {
    return server !== undefined
  }
}
