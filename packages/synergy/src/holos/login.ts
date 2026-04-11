import * as prompts from "@clack/prompts"
import open from "open"
import { UI } from "@/cli/ui"
import { HolosLoginFlow } from "./login-flow"

const LOGIN_TIMEOUT_MS = 5 * 60_000
const DIM = UI.Style.TEXT_DIM
const RESET = UI.Style.TEXT_NORMAL
const GREEN = UI.Style.TEXT_SUCCESS

export async function performHolosLogin(options?: { silent?: boolean }): Promise<{ agentId: string } | null> {
  const state = crypto.randomUUID()
  const port = 19836 + Math.floor(Math.random() * 1000)
  const callbackUrl = `http://127.0.0.1:${port}/holos/login`

  let resolveCallback: (params: { code: string; state: string }) => void
  let rejectCallback: (err: Error) => void
  const callbackPromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      port,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname !== "/holos/login") {
          return new Response("Not found", { status: 404 })
        }

        const code = url.searchParams.get("code")
        const returnedState = url.searchParams.get("state")
        if (!code || !returnedState) {
          rejectCallback(new Error("Missing code or state in callback"))
          return new Response(html("Login failed: missing parameters"), {
            headers: { "Content-Type": "text/html" },
          })
        }

        resolveCallback({ code, state: returnedState })
        return new Response(html("Login successful! You can close this page."), {
          headers: { "Content-Type": "text/html" },
        })
      },
    })
  } catch {
    return null
  }

  const bindUrl = HolosLoginFlow.createBindUrl({ callbackUrl, state })

  try {
    await open(bindUrl)
  } catch {
    if (!(options?.silent ?? false)) {
      prompts.log.warn(`Failed to open browser automatically. Please open this URL manually:\n${bindUrl}`)
    }
  }

  const silent = options?.silent ?? false
  const spinner = silent ? undefined : prompts.spinner()
  spinner?.start("Waiting for browser login...")

  try {
    const timeout = setTimeout(() => rejectCallback(new Error("Login timed out")), LOGIN_TIMEOUT_MS)
    const params = await callbackPromise
    clearTimeout(timeout)

    if (params.state !== state) {
      spinner?.stop("State mismatch — possible CSRF attack", 1)
      return null
    }

    spinner?.message("Exchanging credentials...")

    const { agentId, agentSecret } = await HolosLoginFlow.exchange({ code: params.code, state: params.state })
    await HolosLoginFlow.saveAndReload({ agentId, agentSecret })

    spinner?.stop(`${GREEN}●${RESET} Bound as ${DIM}${agentId}${RESET}`)

    prompts.log.message(
      UI.card({
        title: "⚠  SAVE YOUR CREDENTIALS",
        titleStyle: UI.Style.TEXT_WARNING_BOLD,
        description: "The secret cannot be recovered — Holos only stores a hash.",
        rows: [
          { label: "Agent ID", value: agentId, valueStyle: UI.Style.TEXT_HIGHLIGHT },
          { label: "Agent Secret", value: agentSecret },
        ],
        footer: "Store these in a password manager or secure location.",
        minWidth: 60,
      }),
    )

    return { agentId }
  } catch (err) {
    spinner?.stop(`Login failed: ${err instanceof Error ? err.message : String(err)}`, 1)
    return null
  } finally {
    server.stop()
  }
}

function html(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Synergy Login</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:3rem;border-radius:1rem;background:#1a1a1a;border:1px solid #333}</style>
</head><body><div class="card"><h2>${message}</h2></div></body></html>`
}
