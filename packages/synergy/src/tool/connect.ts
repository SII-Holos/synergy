import z from "zod"
import { MetaProtocolEnv } from "@ericsanchezok/meta-protocol"
import { Tool } from "./tool"
import { RemoteExecution } from "./remote-execution"

const CONNECT_TIMEOUT_MS = 30_000

const parameters = z.object({
  action: z.enum(["open", "close", "status", "list"]).describe("Remote session action to perform"),
  envID: MetaProtocolEnv.EnvID.optional().describe(
    "Remote execution environment ID. Required except for list. Use a real remote envID such as 'env_...'; do not pass local aliases like ':local' or 'local'.",
  ),
  targetAgentID: z.string().optional().describe("Holos target agent ID. Required for open."),
  label: z.string().optional().describe("Optional label for the remote collaboration session."),
})

type ConnectMetadata = {
  action: "open" | "close" | "status" | "list"
  envID?: string
  targetAgentID?: string
  sessionID?: string
  status?: string
  sessions?: Array<{
    envID: string
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
    "Manage explicit remote collaboration sessions for meta-synergy hosts. Open a session before running remote bash or process commands, then close it when done.",
  parameters,
  async execute(params) {
    if (params.action === "list") {
      const sessions = RemoteExecution.allSessions()
      return {
        title: "Remote sessions",
        metadata: {
          action: "list",
          sessions: sessions.map((session) => ({ ...session })),
        },
        output:
          sessions.length === 0
            ? "No active remote sessions."
            : sessions
                .map(
                  (session) =>
                    `${session.envID} -> ${session.targetAgentID} :: ${session.sessionID} (${session.status})`,
                )
                .join("\n"),
      }
    }

    if (!params.envID) {
      throw new Error(
        "connect requires a real remote envID for actions other than list. Omit envID for local bash/process execution; do not pass local aliases like ':local' or 'local'.",
      )
    }

    const normalizedEnvID = RemoteExecution.normalizeEnvID(params.envID)
    if (!normalizedEnvID) {
      throw new Error(
        `connect cannot use envID "${params.envID}" because it resolves to the local machine. Omit envID for local bash/process execution. Use a real remote envID such as "env_..." when opening or checking a remote session.`,
      )
    }

    if (params.action === "status") {
      const session = RemoteExecution.getSession(normalizedEnvID)
      return {
        title: session ? "Connection status" : "Connection not found",
        metadata: {
          action: "status",
          envID: normalizedEnvID,
          targetAgentID: session?.targetAgentID,
          sessionID: session?.sessionID,
          status: session?.status ?? "missing",
        },
        output: session ? JSON.stringify(session, null, 2) : `No active connection for env ${normalizedEnvID}.`,
      }
    }

    if (params.action === "open") {
      if (!params.targetAgentID) {
        throw new Error(
          `connect open requires targetAgentID. Provide the Holos target agent ID together with a real remote envID such as "env_...".`,
        )
      }
      const client = RemoteExecution.requireClient(normalizedEnvID, "connect")

      let opened
      try {
        opened = await Promise.race([
          client.executeSession(
            normalizedEnvID,
            { action: "open", label: params.label },
            { targetAgentID: params.targetAgentID },
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Connection to env "${normalizedEnvID}" timed out after ${CONNECT_TIMEOUT_MS / 1000}s. The remote host may be unreachable or slow to respond.`,
                  ),
                ),
              CONNECT_TIMEOUT_MS,
            ),
          ),
        ])
      } catch (error) {
        throw new Error(
          `Failed to open connection to env "${normalizedEnvID}": ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const sessionID = opened.metadata.sessionID
      if (!sessionID) {
        throw new Error(`Connection open for env ${normalizedEnvID} did not return a session ID.`)
      }

      RemoteExecution.upsertSession({
        envID: normalizedEnvID,
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
          envID: normalizedEnvID,
          targetAgentID: params.targetAgentID,
          sessionID,
          status: opened.metadata.status,
        },
        output: opened.output,
      }
    }

    const client = RemoteExecution.requireClient(normalizedEnvID, "connect")
    const session = RemoteExecution.requireSession(normalizedEnvID)

    let closed
    try {
      closed = await Promise.race([
        client.executeSession(
          normalizedEnvID,
          { action: "close", sessionID: session.sessionID },
          { targetAgentID: session.targetAgentID },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Closing connection to env "${normalizedEnvID}" timed out after ${CONNECT_TIMEOUT_MS / 1000}s.`,
                ),
              ),
            CONNECT_TIMEOUT_MS,
          ),
        ),
      ])
    } catch (error) {
      RemoteExecution.clearSession(normalizedEnvID)
      throw new Error(
        `Failed to close connection to env "${normalizedEnvID}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    RemoteExecution.clearSession(normalizedEnvID)

    return {
      title: "Disconnected",
      metadata: {
        action: "close",
        envID: normalizedEnvID,
        targetAgentID: session.targetAgentID,
        sessionID: session.sessionID,
        status: closed.metadata.status,
      },
      output: closed.output,
    }
  },
})
