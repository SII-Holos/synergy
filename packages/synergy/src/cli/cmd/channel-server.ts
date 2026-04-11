import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Server } from "../../server/server"
import { isServerReachable } from "../network"
import * as ChannelTypes from "../../channel/types"

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
    "  synergy channel <cmd> --attach http://host:port",
  )
  UI.empty()
  return false
}

export async function fetchChannelApi(
  serverUrl: string,
  path: string,
  method: "GET" | "POST" = "GET",
): Promise<Record<string, ChannelTypes.Status>> {
  const url = `${serverUrl.replace(/\/+$/, "")}/channel${path}`
  const response = await fetch(url, {
    method,
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Server responded with ${response.status}: ${body}`)
  }
  return (await response.json()) as Record<string, ChannelTypes.Status>
}

export type ChannelStartAttempt =
  | { kind: "connected"; statuses: Record<string, ChannelTypes.Status> }
  | { kind: "unavailable" }
  | { kind: "failed"; error: string }

export async function startChannelIfServerRunning(input: {
  serverUrl: string
  channelType: string
  accountId: string
}): Promise<ChannelStartAttempt> {
  if (!(await isServerReachable(input.serverUrl))) {
    return { kind: "unavailable" }
  }

  try {
    const statuses = await fetchChannelApi(input.serverUrl, `/${input.channelType}/${input.accountId}/start`, "POST")
    return { kind: "connected", statuses }
  } catch (error) {
    return {
      kind: "failed",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
