import { UI } from "../ui"
import { Server } from "../../server/server"
import { isServerReachable } from "../network"

export const attachOption = {
  attach: {
    type: "string" as const,
    describe: "URL of a running synergy server",
    default: Server.DEFAULT_URL,
  },
}

export async function ensureServer(serverUrl: string): Promise<boolean> {
  if (await isServerReachable(serverUrl)) return true
  UI.error(`No running server at ${serverUrl}`)
  UI.println(UI.Style.TEXT_DIM + "  Start a server:", UI.Style.TEXT_NORMAL, "  synergy start")
  UI.println(
    UI.Style.TEXT_DIM + "  Or specify a different server:",
    UI.Style.TEXT_NORMAL,
    "  synergy holos <cmd> --attach http://host:port",
  )
  UI.empty()
  return false
}

export async function fetchHolosApi<T>(input: {
  serverUrl: string
  path: string
  method?: "GET" | "POST" | "PUT" | "DELETE"
  body?: unknown
}): Promise<T> {
  const url = `${input.serverUrl.replace(/\/+$/, "")}/holos${input.path}`
  const response = await fetch(url, {
    method: input.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Server responded with ${response.status}: ${body}`)
  }
  return (await response.json()) as T
}
