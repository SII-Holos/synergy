import { Bus } from "../bus"
import { LoopEvent } from "../blueprint/event"
import { Log } from "../util/log"
import { ScopedState } from "../scope/scoped-state"
import { LatticeMachine } from "./machine"
import { LatticeStore } from "./store"

/**
 * LatticeBridge translates BlueprintLoop terminal events into Pathway/phase
 * transitions for the owning Lattice run. It only acts on loops carrying
 * `orchestration.kind === "lattice"` and only while the run is active; a paused
 * or cancelled run records nothing.
 */
export namespace LatticeBridge {
  const log = Log.create({ service: "lattice.bridge" })

  const subscription = ScopedState.create(
    () => {
      const unsubscribe = Bus.subscribe(LoopEvent.Updated, (event) => {
        handle(event.properties.loop).catch((error) => {
          log.error("lattice bridge failed", { loopID: event.properties.loop.id, error })
        })
      })
      return { unsubscribe }
    },
    async (state) => state.unsubscribe(),
  )

  export function init(): () => void {
    return subscription().unsubscribe
  }

  async function handle(loop: {
    id: string
    scopeID: string
    sessionID: string
    status: string
    error?: string
    orchestration?: { kind: "lattice"; runID: string }
  }): Promise<void> {
    if (loop.orchestration?.kind !== "lattice") return
    if (loop.status !== "completed" && loop.status !== "failed" && loop.status !== "cancelled") return

    const run = await LatticeStore.getOrUndefined(loop.scopeID, loop.sessionID)
    if (!run) return
    if (run.status !== "active") return // paused/cancelled/completed runs are inert

    if (loop.status === "completed") {
      await LatticeMachine.onLoopCompleted(loop.scopeID, loop.sessionID, loop.id)
    } else if (loop.status === "failed") {
      await LatticeMachine.onLoopFailed(loop.scopeID, loop.sessionID, loop.id, loop.error)
    } else if (loop.status === "cancelled") {
      await LatticeMachine.onLoopCancelled(loop.scopeID, loop.sessionID, loop.id)
    }
  }
}
