import z from "zod"
import { SynergyLinkIdentity } from "@ericsanchezok/synergy-link-protocol"
import { Tool } from "./tool"
import { SynergyLinkExecution } from "./synergy-link-execution"
import { ToolTimeout } from "./timeout"

const CONNECT_TIMEOUT_MS = ToolTimeout.DEFAULTS.connectMs

const parameters = z.object({
  action: z.enum(["open", "close", "status", "list"]).describe("Synergy Link session action to perform"),
  linkID: z.string().optional().describe("Synergy Link target ID. Required except for list. Must start with link_."),
  targetAgentID: z.string().optional().describe("Holos target agent ID. Required for open."),
  label: z.string().optional().describe("Optional label for the Synergy Link session."),
})

type ConnectMetadata = {
  action: "open" | "close" | "status" | "list"
  linkID?: string
  targetAgentID?: string
  sessionID?: string
  status?: string
  sessions?: Array<{
    linkID: string
    targetAgentID: string
    sessionID: string
    status: string
    label?: string
    openedAt: number
    lastUsedAt: number
  }>
}

export const ConnectTool = Tool.define<typeof parameters, ConnectMetadata>("connect", {
  description:
    "Manage explicit Synergy Link sessions. Open a session before running remote bash or process commands. connect requires a valid linkID for remote lifecycle actions and never falls back locally.",
  parameters,
  async execute(params) {
    if (params.action === "list") {
      const sessions = SynergyLinkExecution.allSessions()
      return {
        title: "Synergy Link sessions",
        metadata: {
          action: "list",
          sessions: sessions.map((session) => ({ ...session })),
        },
        output:
          sessions.length === 0
            ? "No active Synergy Link sessions."
            : sessions
                .map(
                  (session) =>
                    `${session.linkID} -> ${session.targetAgentID} :: ${session.sessionID} (${session.status})`,
                )
                .join("\n"),
      }
    }

    const linkID = SynergyLinkIdentity.requireLinkID(params.linkID)

    if (params.action === "status") {
      const session = SynergyLinkExecution.getSession(linkID)
      return {
        title: session ? "Connection status" : "Connection not found",
        metadata: {
          action: "status",
          linkID,
          targetAgentID: session?.targetAgentID,
          sessionID: session?.sessionID,
          status: session?.status ?? "missing",
        },
        output: session ? JSON.stringify(session, null, 2) : `No active connection for link ${linkID}.`,
      }
    }

    if (params.action === "open") {
      if (!params.targetAgentID) {
        throw new Error(
          `connect open requires targetAgentID. Provide it together with a Synergy Link ID such as "link_...".`,
        )
      }
      const client = SynergyLinkExecution.requireClient(linkID, "connect")

      let opened
      try {
        opened = await Promise.race([
          client.executeSession(
            linkID,
            { action: "open", label: params.label },
            { targetAgentID: params.targetAgentID },
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Connection to link "${linkID}" timed out after ${CONNECT_TIMEOUT_MS / 1000}s. The Synergy Link host may be unreachable or slow to respond.`,
                  ),
                ),
              CONNECT_TIMEOUT_MS,
            ),
          ),
        ])
      } catch (error) {
        throw new Error(
          `Failed to open connection to link "${linkID}": ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const sessionID = opened.metadata.sessionID
      if (!sessionID) {
        throw new Error(`Connection open for link ${linkID} did not return a session ID.`)
      }

      SynergyLinkExecution.upsertSession({
        linkID,
        targetAgentID: params.targetAgentID,
        sessionID,
        status: "opened",
        label: params.label,
        openedAt: Date.now(),
        lastUsedAt: Date.now(),
      })

      return {
        title: "Connected",
        metadata: {
          action: "open",
          linkID,
          targetAgentID: params.targetAgentID,
          sessionID,
          status: opened.metadata.status,
        },
        output: opened.output,
      }
    }

    const client = SynergyLinkExecution.requireClient(linkID, "connect")
    const session = SynergyLinkExecution.requireSession(linkID)

    let closed
    try {
      closed = await Promise.race([
        client.executeSession(
          linkID,
          { action: "close", sessionID: session.sessionID },
          { targetAgentID: session.targetAgentID },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(`Closing connection to link "${linkID}" timed out after ${CONNECT_TIMEOUT_MS / 1000}s.`),
              ),
            CONNECT_TIMEOUT_MS,
          ),
        ),
      ])
    } catch (error) {
      SynergyLinkExecution.clearSession(linkID)
      throw new Error(
        `Failed to close connection to link "${linkID}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    SynergyLinkExecution.clearSession(linkID)

    return {
      title: "Disconnected",
      metadata: {
        action: "close",
        linkID,
        targetAgentID: session.targetAgentID,
        sessionID: session.sessionID,
        status: closed.metadata.status,
      },
      output: closed.output,
    }
  },
})
