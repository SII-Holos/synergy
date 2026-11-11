import { Cortex } from "./manager"
import { CortexTypes } from "./types"
import { CortexMaintenanceHolds } from "./maintenance-holds"
import { Session } from "../session"
import { SessionRecords } from "../session/records"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import { RuntimeMaintenance } from "../storage/runtime-maintenance"

async function* activeSessions() {
  for await (const row of Storage.records<Record<string, unknown>>({ kind: "session", limit: 128 })) {
    const cortex = row.value.cortex
    if (cortex === undefined) continue
    const status = CortexTypes.TaskStatus.safeParse(
      cortex && typeof cortex === "object" && "status" in cortex ? cortex.status : undefined,
    )
    if (!status.success)
      throw new RuntimeMaintenance.Blocked({
        message: "An unknown Cortex status cannot establish native writer drainage",
        requirements: [
          {
            code: "cortex_status_unknown",
            owner: "cortex",
            label: "Reconcile the unknown Cortex writer schema",
            recoverable: true,
          },
        ],
      })
    if (CortexTypes.isTerminalStatus(status.data)) continue
    yield await SessionRecords.read(row.key)
  }
}

export function registerCortexMaintenanceOwner() {
  RuntimeMaintenance.register("cortex", {
    version: 1,
    order: 20,
    async suspend(context) {
      for await (const session of activeSessions()) {
        context.signal.throwIfAborted()
        await ScopeContext.provide({
          scope: session.scope,
          workspace: null,
          fn: () => Cortex.suspendForMaintenance(session.id, context),
        })
      }
    },
    async drain(context) {
      context.signal.throwIfAborted()
      await Cortex.drain()
    },
    async inspect(context) {
      const requirements: RuntimeMaintenance.Requirement[] = []
      for await (const session of activeSessions()) {
        context.signal.throwIfAborted()
        const requirement = await ScopeContext.provide({
          scope: session.scope,
          workspace: null,
          fn: () => Cortex.inspectMaintenance(session.id, context),
        })
        if (requirement) requirements.push(requirement)
      }
      return requirements
    },
    async release(context) {
      for await (const row of CortexMaintenanceHolds.list(context.maintenanceID)) {
        context.signal.throwIfAborted()
        const session = await Session.get(row.sessionID)
        if (session.scope.id !== row.scopeID || session.cortex?.taskID !== row.taskID)
          throw new RuntimeMaintenance.Blocked({
            message: "Cortex maintenance index no longer matches its canonical task",
          })
        await ScopeContext.provide({
          scope: session.scope,
          workspace: null,
          fn: () => Cortex.releaseMaintenance(session.id, context),
        })
      }
    },
  })
}
