import process from "node:process"
import { createServer, type IncomingMessage } from "node:http"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { MetaSynergyStore, type MetaSynergyAuthState } from "../state/store"
import { HOLOS_PORTAL_URL, HOLOS_URL, MetaSynergyHolosAuth } from "./auth"
import { MetaSynergyHolosProtocol } from "./protocol"

const LOGIN_TIMEOUT_MS = 5 * 60_000

export namespace MetaSynergyHolosLogin {
  export function createBindURL(input: { callbackURL: string; state: string }) {
    return (
      `${HOLOS_PORTAL_URL}/api/v1/holos/agent_tunnel/bind/start` +
      `?local_callback=${encodeURIComponent(input.callbackURL)}` +
      `&state=${encodeURIComponent(input.state)}`
    )
  }

  export async function verifySecret(agentSecret: string): Promise<{ valid: true } | { valid: false; reason: string }> {
    const response = await fetch(`${HOLOS_URL}/api/v1/holos/agent_tunnel/ws_token`, {
      headers: { Authorization: `Bearer ${agentSecret}` },
    })
    const body = MetaSynergyHolosProtocol.WsTokenResponse.safeParse(await response.json())
    if (!body.success || !response.ok || body.data.code !== 0) {
      return { valid: false, reason: body.success ? (body.data.message ?? "Invalid response") : "Invalid response" }
    }
    return { valid: true }
  }

  export async function loginWithExistingCredentials(auth: MetaSynergyAuthState): Promise<{ agentID: string }> {
    const verification = await verifySecret(auth.agentSecret)
    if (!verification.valid) {
      throw new Error(`Credential validation failed: ${verification.reason}`)
    }

    await MetaSynergyHolosAuth.save(auth)
    return { agentID: auth.agentID }
  }

  export async function promptForExistingCredentials(): Promise<MetaSynergyAuthState | null> {
    const agentID = await promptText("Agent ID: ")
    if (!agentID) {
      return null
    }

    const agentSecret = await promptSecret("Agent Secret: ")
    if (!agentSecret) {
      return null
    }

    return {
      agentID,
      agentSecret,
    }
  }

  export async function promptLoginMode(): Promise<"browser" | "existing" | null> {
    if (!input.isTTY || !output.isTTY) {
      return null
    }

    while (true) {
      output.write(
        ["Choose login mode:", "  1) Browser login", "  2) Import existing agent credentials", "Select [1]: "].join(
          "\n",
        ),
      )

      const answer = await readLine()
      const normalized = answer.trim().toLowerCase()
      if (normalized === "" || normalized === "1" || normalized === "browser" || normalized === "b") {
        return "browser"
      }
      if (normalized === "2" || normalized === "existing" || normalized === "import" || normalized === "i") {
        return "existing"
      }
      output.write("Invalid selection. Enter 1 or 2.\n\n")
    }
  }

  export async function login(): Promise<{ agentID: string }> {
    await MetaSynergyStore.ensureRoot()
    const state = crypto.randomUUID()
    const port = 19836 + Math.floor(Math.random() * 1000)
    const callbackURL = `http://127.0.0.1:${port}/holos/login`
    const bindURL = createBindURL({ callbackURL, state })

    const callback = new Promise<{ code: string; state: string }>((resolve, reject) => {
      const server = createServer((request, response) => {
        const params = parseRequest(request)
        if (!params || params.pathname !== "/holos/login") {
          response.statusCode = 404
          response.end("Not found")
          return
        }

        server.close()
        if (!params.code || !params.state) {
          reject(new Error("Missing login callback parameters."))
          response.statusCode = 400
          response.setHeader("Content-Type", "text/html; charset=utf-8")
          response.end(
            htmlPage({
              title: "MetaSynergy Login",
              status: "failed",
              heading: "Login failed",
              message: "Missing callback parameters. Please return to MetaSynergy and try again.",
            }),
          )
          return
        }

        resolve({ code: params.code, state: params.state })
        response.setHeader("Content-Type", "text/html; charset=utf-8")
        response.end(
          htmlPage({
            title: "MetaSynergy Login",
            status: "success",
            heading: "MetaSynergy is ready",
            message: "Login successful. You can close this page and return to the app.",
          }),
        )
      })
      server.listen(port, "127.0.0.1")

      const timer = setTimeout(() => {
        server.close()
        reject(new Error("Login timed out."))
      }, LOGIN_TIMEOUT_MS)
      timer.unref?.()
    })

    try {
      await launchBrowser(bindURL)
    } catch {
      console.log(`Open this URL to continue login:\n${bindURL}`)
    }

    const params = await callback
    if (params.state !== state) {
      throw new Error("State mismatch during Holos login.")
    }

    const exchangeResponse = await fetch(`${HOLOS_URL}/api/v1/holos/agent_tunnel/bind/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: params.code,
        state: params.state,
        profile: { name: "Meta Synergy Host" },
      }),
    })
    if (!exchangeResponse.ok) {
      throw new Error(`Exchange failed: ${exchangeResponse.status} ${exchangeResponse.statusText}`)
    }

    const exchangeBody = MetaSynergyHolosProtocol.BindExchangeResponse.parse(await exchangeResponse.json())
    if (exchangeBody.code !== 0) {
      throw new Error(exchangeBody.message ?? exchangeBody.msg ?? "Holos exchange failed.")
    }

    const agentSecret = exchangeBody.data.agent_secret ?? exchangeBody.data.secret
    if (!agentSecret) {
      throw new Error("Holos exchange did not return an agent secret.")
    }

    return await loginWithExistingCredentials({
      agentID: exchangeBody.data.agent_id,
      agentSecret,
    })
  }
}

function parseRequest(request: IncomingMessage) {
  if (!request.url) return
  const url = new URL(request.url, "http://127.0.0.1")
  return {
    pathname: url.pathname,
    code: url.searchParams.get("code") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
  }
}

async function launchBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url]
  const child = spawn(command[0], command.slice(1), { stdio: "ignore", detached: true })
  child.unref()
}

async function promptText(prompt: string): Promise<string | null> {
  if (!input.isTTY || !output.isTTY) {
    return null
  }

  output.write(prompt)
  const answer = await readLine()
  const value = answer.trim()
  return value ? value : null
}

async function promptSecret(prompt: string): Promise<string | null> {
  if (!input.isTTY || !output.isTTY) {
    return null
  }

  output.write(prompt)
  const secret = await readSecretLine()
  output.write("\n")
  const value = secret.trim()
  return value ? value : null
}

async function readLine(): Promise<string> {
  const rl = createInterface({ input, output, terminal: false })
  try {
    return await rl.question("")
  } finally {
    rl.close()
  }
}

async function readSecretLine(): Promise<string> {
  if (!input.isTTY) {
    return await readLine()
  }

  const previousRawMode = typeof input.setRawMode === "function" ? input.isRaw : undefined
  const chunks: string[] = []

  return await new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      input.off("data", onData)
      input.off("error", onError)
      if (typeof input.setRawMode === "function") {
        input.setRawMode(Boolean(previousRawMode))
      }
      input.pause()
    }

    const finish = () => {
      cleanup()
      resolve(chunks.join(""))
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          finish()
          return
        }
        if (char === "\u0003") {
          cleanup()
          reject(new Error("Cancelled"))
          return
        }
        if (char === "\u007f" || char === "\b") {
          chunks.pop()
          continue
        }
        chunks.push(char)
      }
    }

    if (typeof input.setRawMode === "function") {
      input.setRawMode(true)
    }
    input.resume()
    input.on("data", onData)
    input.on("error", onError)
  })
}

function htmlPage(input: { title: string; status: "success" | "failed"; heading: string; message: string }): string {
  const accent = input.status === "success" ? "#86efac" : "#fca5a5"
  const badge = input.status === "success" ? "Connected" : "Error"
  const symbol = input.status === "success" ? "✓" : "!"

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #050816;
        --panel: rgba(12, 18, 38, 0.82);
        --panel-border: rgba(255, 255, 255, 0.12);
        --text: #f8fafc;
        --text-dim: rgba(226, 232, 240, 0.72);
        --accent: ${accent};
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
          sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top, rgba(79, 70, 229, 0.28), transparent 34%),
          radial-gradient(circle at bottom right, rgba(34, 197, 94, 0.18), transparent 30%),
          linear-gradient(180deg, #030712 0%, var(--bg) 100%);
      }

      .shell {
        width: min(100%, 560px);
        border-radius: 24px;
        border: 1px solid var(--panel-border);
        background: var(--panel);
        backdrop-filter: blur(22px);
        box-shadow:
          0 24px 80px rgba(0, 0, 0, 0.42),
          inset 0 1px 0 rgba(255, 255, 255, 0.06);
        overflow: hidden;
      }

      .masthead {
        padding: 20px 24px 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .brand {
        font-size: 13px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--text-dim);
      }

      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 12px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: var(--text);
        font-size: 12px;
      }

      .badge::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--accent);
        box-shadow: 0 0 16px var(--accent);
      }

      .content {
        padding: 28px 24px 30px;
        text-align: center;
      }

      .mark {
        width: 72px;
        height: 72px;
        margin: 0 auto 18px;
        border-radius: 22px;
        display: grid;
        place-items: center;
        font-size: 34px;
        font-weight: 700;
        color: #04111f;
        background: linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,255,255,0.8));
        box-shadow:
          0 12px 30px rgba(0, 0, 0, 0.24),
          0 0 0 6px rgba(255, 255, 255, 0.03);
      }

      h1 {
        margin: 0 0 10px;
        font-size: clamp(28px, 6vw, 36px);
        line-height: 1.05;
      }

      p {
        margin: 0 auto;
        max-width: 34ch;
        color: var(--text-dim);
        font-size: 15px;
        line-height: 1.6;
      }

      .footer {
        margin-top: 24px;
        padding-top: 18px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        color: rgba(226, 232, 240, 0.58);
        font-size: 12px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="masthead">
        <div class="brand">MetaSynergy</div>
        <div class="badge">${badge}</div>
      </div>
      <section class="content">
        <div class="mark">${symbol}</div>
        <h1>${escapeHtml(input.heading)}</h1>
        <p>${escapeHtml(input.message)}</p>
        <div class="footer">Holos agent tunnel</div>
      </section>
    </main>
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
