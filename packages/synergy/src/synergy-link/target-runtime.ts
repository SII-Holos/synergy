import type { SynergyLinkClient } from "@ericsanchezok/synergy-link-protocol"
import { SynergyLinkExecution } from "@/tool/synergy-link-execution"
import { ToolTimeout } from "@/tool/timeout"
import { withTimeout } from "@/util/timeout"
import { SynergyLinkTargetService } from "./target-service"
import { SynergyLinkTargetStore } from "./target-store"
import { SynergyLinkTarget } from "./types"

export namespace SynergyLinkTargetRuntime {
  export function view(target: SynergyLinkTarget.Info): SynergyLinkTarget.View {
    const session = SynergyLinkExecution.getSession(target.linkID, {
      targetID: target.id,
      targetAgentID: target.targetAgentID,
    })
    return SynergyLinkTarget.View.parse({
      ...target,
      availability:
        session?.status === "opened" ? "connected" : SynergyLinkExecution.getClient() ? "idle" : "holos_offline",
      sessionID: session?.sessionID,
    })
  }

  export async function list(agent?: string): Promise<SynergyLinkTarget.View[]> {
    const targets = agent ? await SynergyLinkTargetStore.listForAgent(agent) : await SynergyLinkTargetStore.list()
    return targets.map(view)
  }

  export async function probe(id: string): Promise<SynergyLinkTarget.View> {
    const target = await SynergyLinkTargetStore.require(id)
    if (!target.enabled) throw new Error(`Synergy Link target is disabled: ${target.id}`)
    const client = SynergyLinkExecution.requireClient(target.linkID, "connect")
    const existing = SynergyLinkExecution.getSession(target.linkID, {
      targetID: target.id,
      targetAgentID: target.targetAgentID,
    })
    let temporarySessionID: string | undefined
    let primaryError: unknown

    try {
      const result = existing
        ? await withTimeout(
            client.executeSession(
              target.linkID,
              { action: "heartbeat", sessionID: existing.sessionID },
              { targetAgentID: existing.targetAgentID },
            ),
            ToolTimeout.DEFAULTS.connectMs,
            { message: `Connection test for target "${target.name}" timed out.` },
          )
        : await withTimeout(
            client.executeSession(
              target.linkID,
              { action: "open", label: `Connection test: ${target.name}` },
              { targetAgentID: target.targetAgentID },
            ),
            ToolTimeout.DEFAULTS.connectMs,
            { message: `Connection test for target "${target.name}" timed out.` },
          )

      if (!existing && result.metadata.status === "opened" && result.metadata.sessionID) {
        temporarySessionID = result.metadata.sessionID
      }
      const probeStatus =
        result.metadata.status === "busy" ? "busy" : result.metadata.status === "refused" ? "refused" : "reachable"
      const updated = await SynergyLinkTargetService.recordProbe(target.id, {
        status: probeStatus,
        host: result.metadata.host ? { ...result.metadata.host, observedAt: Date.now() } : undefined,
      })
      return view(updated)
    } catch (error) {
      primaryError = error
      await SynergyLinkTargetService.recordProbe(target.id, { status: "failed" }).catch(() => undefined)
      throw error
    } finally {
      if (temporarySessionID) {
        try {
          await closeProbeSession(client, target, temporarySessionID)
        } catch (error) {
          if (primaryError === undefined) throw error
        }
      }
    }
  }

  async function closeProbeSession(
    client: SynergyLinkClient.ExecutionClient,
    target: SynergyLinkTarget.Info,
    sessionID: string,
  ) {
    await withTimeout(
      client.executeSession(target.linkID, { action: "close", sessionID }, { targetAgentID: target.targetAgentID }),
      ToolTimeout.DEFAULTS.connectMs,
      { message: `Closing the connection test for target "${target.name}" timed out.` },
    )
  }
}
