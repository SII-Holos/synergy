import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { SynergyLinkExecution } from "@/tool/synergy-link-execution"
import { ToolTimeout } from "@/tool/timeout"
import { Log } from "@/util/log"
import { withTimeout } from "@/util/timeout"
import z from "zod"
import { SynergyLinkTargetStore } from "./target-store"
import { SynergyLinkTarget } from "./types"

const log = Log.create({ service: "synergy-link.target-service" })

export namespace SynergyLinkTargetService {
  export const Event = {
    Created: BusEvent.define("synergy_link.target.created", z.object({ target: SynergyLinkTarget.Info })),
    Updated: BusEvent.define("synergy_link.target.updated", z.object({ target: SynergyLinkTarget.Info })),
    Removed: BusEvent.define("synergy_link.target.removed", z.object({ id: SynergyLinkTarget.ID })),
  }

  export async function create(input: SynergyLinkTarget.CreateInput) {
    return ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const target = await SynergyLinkTargetStore.create(input)
        await Bus.publish(Event.Created, { target })
        return target
      },
    })
  }

  export async function update(id: string, input: SynergyLinkTarget.PatchInput) {
    return ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const parsed = SynergyLinkTarget.PatchInput.parse(input)
        const nextLinkID = parsed.linkID
        const nextTargetAgentID = parsed.targetAgentID
        const relink = nextLinkID !== undefined && nextTargetAgentID !== undefined
        if (!relink) {
          const target = await SynergyLinkTargetStore.update(id, input)
          await Bus.publish(Event.Updated, { target })
          return target
        }

        const current = await SynergyLinkTargetStore.require(id)
        const client = SynergyLinkExecution.requireClient(nextLinkID, "connect")
        let temporarySessionID: string | undefined
        try {
          const probe = await withTimeout(
            client.executeSession(
              nextLinkID,
              { action: "open", label: `Relink verification: ${current.name}` },
              { targetAgentID: nextTargetAgentID },
            ),
            ToolTimeout.DEFAULTS.connectMs,
            { message: `Verifying the new locator for target "${current.name}" timed out.` },
          )
          if (probe.metadata.status !== "opened" || !probe.metadata.sessionID) {
            throw new Error(
              `The new Synergy Link locator for target "${current.name}" could not be verified (status: ${probe.metadata.status}).`,
            )
          }
          temporarySessionID = probe.metadata.sessionID
          if (probe.metadata.host && probe.metadata.host.linkID !== nextLinkID) {
            throw new Error(`Synergy Link host identity mismatch for target ${id}`)
          }

          const updated = await SynergyLinkTargetStore.update(id, {
            targetAgentID: nextTargetAgentID,
            linkID: nextLinkID,
          })
          SynergyLinkExecution.clearSession(current.linkID, {
            targetID: current.id,
            targetAgentID: current.targetAgentID,
          })
          const probed = await SynergyLinkTargetStore.recordProbe(id, {
            status: "reachable",
            host: probe.metadata.host ? { ...probe.metadata.host, observedAt: Date.now() } : undefined,
          })
          await Bus.publish(Event.Updated, { target: probed })
          return probed
        } finally {
          if (temporarySessionID) {
            await withTimeout(
              client.executeSession(
                nextLinkID,
                { action: "close", sessionID: temporarySessionID },
                { targetAgentID: nextTargetAgentID },
              ),
              ToolTimeout.DEFAULTS.connectMs,
              { message: `Closing the relink verification session for target "${current.name}" timed out.` },
            ).catch((error) => {
              log.warn("failed to close relink verification session", { targetID: id, error })
            })
          }
        }
      },
    })
  }

  export async function recordProbe(id: string, input: Parameters<typeof SynergyLinkTargetStore.recordProbe>[1]) {
    return ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const target = await SynergyLinkTargetStore.recordProbe(id, input)
        await Bus.publish(Event.Updated, { target })
        return target
      },
    })
  }

  export async function remove(id: string) {
    return ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const target = await SynergyLinkTargetStore.require(id)
        const session = SynergyLinkExecution.getSession(target.linkID, {
          targetID: target.id,
          targetAgentID: target.targetAgentID,
        })
        const client = SynergyLinkExecution.getClient()
        if (session?.status === "opened" && client) {
          await withTimeout(
            client.executeSession(
              target.linkID,
              { action: "close", sessionID: session.sessionID },
              { targetAgentID: target.targetAgentID },
            ),
            Math.min(ToolTimeout.DEFAULTS.connectMs, 5_000),
            { message: `Closing the active session for target "${target.id}" timed out.` },
          ).catch((error) => {
            log.warn("failed to close remote session before target removal", { targetID: target.id, error })
          })
        }
        await SynergyLinkTargetStore.remove(target.id)
        SynergyLinkExecution.clearSession(target.linkID, {
          targetID: target.id,
          targetAgentID: target.targetAgentID,
        })
        await Bus.publish(Event.Removed, { id: target.id })
      },
    })
  }
}
