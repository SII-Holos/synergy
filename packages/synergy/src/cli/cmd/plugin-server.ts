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
    "  synergy plugin <cmd> --attach http://host:port",
  )
  UI.empty()
  return false
}

export async function fetchPluginApi<T = any>(
  serverUrl: string,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<T> {
  const url = `${serverUrl.replace(/\/+$/, "")}/api/plugins${path}`
  const init: RequestInit = {
    method,
    headers: { accept: "application/json", "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }
  const response = await fetch(url, init)
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Server responded with ${response.status}: ${text}`)
  }
  return response.json() as T
}

export async function fetchRegistryApi<T = any>(
  serverUrl: string,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<T> {
  const url = `${serverUrl.replace(/\/+$/, "")}/api/registry${path}`
  const init: RequestInit = {
    method,
    headers: { accept: "application/json", "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }
  const response = await fetch(url, init)
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Server responded with ${response.status}: ${text}`)
  }
  return response.json() as T
}
