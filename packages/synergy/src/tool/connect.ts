import z from "zod"
import { SynergyLinkIdentity } from "@ericsanchezok/synergy-link-protocol"
import { Tool } from "./tool"
import { SynergyLinkExecution } from "./synergy-link-execution"
import { SynergyLinkTargetRuntime } from "@/synergy-link/target-runtime"
import { SynergyLinkTargetService } from "@/synergy-link/target-service"
import { SynergyLinkTargetStore } from "@/synergy-link/target-store"
import { ToolTimeout } from "./timeout"

const CONNECT_TIMEOUT_MS = ToolTimeout.DEFAULTS.connectMs

const parameters = z.object({
  action: z.enum(["open", "close", "status", "list", "list_targets"]).describe("Synergy Link action to perform"),
  targetID: z
    .string()
    .optional()
    .describe("Stable persisted Synergy Link target ID. Preferred for open, close, and status."),
  linkID: z.string().optional().describe("Legacy raw Synergy Link locator. Must start with link_."),
  targetAgentID: z.string().optional().describe("Legacy Holos target agent ID. Required with linkID for open."),
  label: z.string().optional().describe("Optional label for the Synergy Link session."),
})

type ConnectMetadata = {
  action: "open" | "close" | "status" | "list" | "list_targets"
  targetID?: string
  linkID?: string
  targetAgentID?: string
  sessionID?: string
  status?: string
  sessions?: Array<{
    targetID?: string
    linkID: string
    targetAgentID: string
    sessionID: string
    status: string
    label?: string
    openedAt: number
    lastUsedAt: number
  }>
  targets?: Array<{
    id: string
    name: string
    enabled: boolean
    authorization: string
    availability: string
    platform?: string
    arch?: string
    runtime?: string
  }>
}

export const ConnectTool = Tool.define<typeof parameters, ConnectMetadata>("connect", {
  description:
    "Discover persisted Synergy Link targets and manage explicit remote sessions. Prefer targetID; raw linkID and targetAgentID are legacy locators. Remote lifecycle actions never fall back locally.",
  parameters,
  async execute(params, ctx) {
    if (params.action === "list_targets") {
      const targets = await SynergyLinkTargetRuntime.list(ctx.agent)
      return {
        title: "Synergy Link targets",
        metadata: {
          action: "list_targets",
          targets: targets.map((target) => ({
            id: target.id,
            name: target.name,
            enabled: target.enabled,
            authorization: target.authorization,
            availability: target.availability,
            platform: target.host?.capabilities.platform,
            arch: target.host?.capabilities.arch,
            runtime: target.host?.capabilities.runtime,
          })),
        },
        output:
          targets.length === 0
            ? "No Synergy Link targets are available to this agent."
            : targets
                .map((target) => `${target.id} — ${target.name} (${target.availability}, ${target.authorization})`)
                .join("\n"),
      }
    }

    if (params.action === "list") {
      const sessions = (
        await Promise.all(
          SynergyLinkExecution.allSessions().map(async (session) => {
            const target = await SynergyLinkTargetStore.findByLocator(session.linkID, session.targetAgentID)
            return !target || SynergyLinkTargetStore.canAgentAccess(target, ctx.agent) ? session : undefined
          }),
        )
      ).flatMap((session) => (session ? [session] : []))
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

    if (params.targetID && params.linkID) throw new Error("Specify targetID or linkID, not both.")
    const target = params.targetID ? await SynergyLinkTargetStore.require(params.targetID) : undefined
    if (target && !target.enabled) throw new Error(`Synergy Link target is disabled: ${target.id}`)
    if (target) SynergyLinkTargetStore.assertAgentAccess(target, ctx.agent)
    const linkID = target?.linkID ?? SynergyLinkIdentity.requireLinkID(params.linkID)
    const activeSession = SynergyLinkExecution.getSession(linkID)
    const targetAgentID =
      target?.targetAgentID ??
      params.targetAgentID ??
      (params.action === "open" ? undefined : activeSession?.targetAgentID)
    const registeredTarget = target ?? (await SynergyLinkTargetStore.findByLocator(linkID, targetAgentID))
    if (registeredTarget) {
      if (!registeredTarget.enabled) throw new Error(`Synergy Link target is disabled: ${registeredTarget.id}`)
      SynergyLinkTargetStore.assertAgentAccess(registeredTarget, ctx.agent)
    }

    if (params.action === "status") {
      const session = SynergyLinkExecution.getSession(linkID)
      return {
        title: session ? "Connection status" : "Connection not found",
        metadata: {
          action: "status",
          targetID: registeredTarget?.id,
          linkID,
          targetAgentID: session?.targetAgentID,
          sessionID: session?.sessionID,
          status: session?.status ?? "missing",
        },
        output: session ? JSON.stringify(session, null, 2) : `No active connection for link ${linkID}.`,
      }
    }

    if (params.action === "open") {
      if (!targetAgentID) {
        throw new Error(
          `connect open requires targetAgentID. Provide it together with a Synergy Link ID such as "link_...".`,
        )
      }
      const client = SynergyLinkExecution.requireClient(linkID, "connect")

      let opened
      try {
        opened = await Promise.race([
          client.executeSession(linkID, { action: "open", label: params.label }, { targetAgentID }),
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

      if (opened.metadata.status !== "opened") {
        SynergyLinkExecution.clearSession(linkID)
        if (registeredTarget) {
          await SynergyLinkTargetService.recordProbe(registeredTarget.id, {
            status: opened.metadata.status === "busy" ? "busy" : "refused",
            host: opened.metadata.host ? { ...opened.metadata.host, observedAt: Date.now() } : undefined,
          })
        }
        return {
          title: opened.title,
          metadata: {
            action: "open",
            targetID: registeredTarget?.id,
            linkID,
            targetAgentID,
            sessionID: opened.metadata.sessionID,
            status: opened.metadata.status,
          },
          output: opened.output,
        }
      }

      const sessionID = opened.metadata.sessionID
      if (!sessionID) {
        throw new Error(`Connection open for link ${linkID} did not return a session ID.`)
      }

      SynergyLinkExecution.upsertSession({
        linkID,
        targetID: registeredTarget?.id,
        targetAgentID,
        sessionID,
        status: "opened",
        label: params.label,
        openedAt: Date.now(),
        lastUsedAt: Date.now(),
      })

      if (registeredTarget && opened.metadata.host) {
        await SynergyLinkTargetService.recordProbe(registeredTarget.id, {
          status: "reachable",
          host: { ...opened.metadata.host, observedAt: Date.now() },
        })
      }

      return {
        title: "Connected",
        metadata: {
          action: "open",
          targetID: registeredTarget?.id,
          linkID,
          targetAgentID,
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
        targetID: registeredTarget?.id ?? session.targetID,
        linkID,
        targetAgentID: session.targetAgentID,
        sessionID: session.sessionID,
        status: closed.metadata.status,
      },
      output: closed.output,
    }
  },
})
