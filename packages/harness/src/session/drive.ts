import { RuntimeContext } from "../lifecycle/context"
import { Log } from "../util/log"
import { ContinuationKernel } from "./continuation-kernel"
import { SessionInbox } from "./inbox"
import { SessionManager } from "./manager"
import { RolloutContinuationRecovery } from "./rollout/continuation-recovery"

export namespace SessionDrive {
  const log = Log.create({ service: "session.drive" })
  const runtimeState = RuntimeContext.state(() => ({
    inflight: new Map<string, Promise<boolean>>(),
  }))

  export interface RequestOptions {
    waitForProcessing?: boolean
  }

  export async function request(sessionID: string, reason: string, options?: RequestOptions): Promise<boolean> {
    const instanceState = runtimeState()

    const previous = instanceState.inflight.get(sessionID)
    const arbitration = previous
      ? previous.then(
          () => arbitrate(sessionID, reason),
          () => arbitrate(sessionID, reason),
        )
      : arbitrate(sessionID, reason)
    const tracked = arbitration.finally(() => {
      if (instanceState.inflight.get(sessionID) === tracked) instanceState.inflight.delete(sessionID)
    })
    instanceState.inflight.set(sessionID, tracked)

    const handled = await tracked
    if (!handled || SessionManager.isRunning(sessionID)) return handled
    if (options?.waitForProcessing) {
      await SessionManager.wake(sessionID)
    } else {
      SessionManager.scheduleWake(sessionID, reason)
    }
    return true
  }

  export function reset(): void {
    const instanceState = runtimeState()

    instanceState.inflight.clear()
  }

  async function arbitrate(sessionID: string, reason: string): Promise<boolean> {
    if (SessionManager.isRunning(sessionID)) return false
    if (await SessionInbox.hasRunnableItem(sessionID)) return true
    if (await RolloutContinuationRecovery.pending(sessionID)) return true

    const proposal = await ContinuationKernel.propose(sessionID)
    if (!proposal) return false
    if (proposal.kind === "handled") return true

    const deliveryKey = proposal.deliveryKey
    if (!deliveryKey) {
      log.error("continuation proposal missing delivery key", { sessionID, reason })
      return false
    }
    await SessionInbox.deliverUnique({
      sessionID,
      deliveryKey,
      mode: proposal.mode,
      message: proposal.message,
    })
    await ContinuationKernel.markCommitted(sessionID, proposal)
    return SessionInbox.hasRunnableItem(sessionID)
  }
}
