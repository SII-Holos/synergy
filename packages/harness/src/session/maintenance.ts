import { RuntimeMaintenance } from "../storage/runtime-maintenance"
import { RuntimeContext } from "../lifecycle/context"
import { SessionManager } from "./manager"

export function registerSessionMaintenanceOwner() {
  RuntimeMaintenance.register("sessions", {
    version: 1,
    order: 100,
    async suspend(context) {
      await RuntimeMaintenance.assertDraining(context.lease)
      SessionManager.closeAdmission()
      for (const runtime of SessionManager.listRunningRuntimes()) {
        context.signal.throwIfAborted()
        SessionManager.signalAbort(runtime.sessionID, { pauseTurn: true })
      }
    },
    async drain(context) {
      await RuntimeMaintenance.assertDraining(context.lease)
      for (const runtime of SessionManager.listRunningRuntimes())
        await SessionManager.waitForIdle(runtime.sessionID, context.signal)
    },
    async inspect(context) {
      context.signal.throwIfAborted()
      return SessionManager.listRunningRuntimes().length
        ? [{ code: "native_turns_active", owner: "sessions", label: "Wait for native Agent turns and their final saves to finish", recoverable: true }]
        : []
    },
    async release(context) {
      context.signal.throwIfAborted()
      if (RuntimeContext.isReady()) SessionManager.openAdmission()
    },
  })
}
