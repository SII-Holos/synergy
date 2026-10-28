import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"

export function holdWorkerQueue(id: string) {
  const lease = SessionManager.acquire(id)
  if (!lease) throw new Error("Expected idle test worker")
  return {
    lease,
    async [Symbol.asyncDispose]() {
      try {
        await SessionInbox.removeByModes(id, ["task", "steer", "context"])
      } finally {
        await SessionManager.release(lease, { requestNextWork: false })
      }
      try {
        await SessionManager.wake(id)
      } finally {
        SessionManager.unregisterRuntime(id)
        await SessionManager.drain()
      }
    },
  }
}
