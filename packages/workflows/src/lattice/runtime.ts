import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { LoopEvent } from "../blueprint/event"
import { NoteEvent } from "@ericsanchezok/synergy-note/event"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopedState } from "@ericsanchezok/synergy-harness/scope/scoped-state"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { LatticeController } from "./controller"
import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"

export namespace LatticeRuntime {
  const log = Log.create({ service: "lattice.runtime" })

  const state = ScopedState.create(
    () => {
      const scope = ScopeContext.current.scope
      const run = (task: () => Promise<void>) => {
        queueMicrotask(() => {
          void ScopeContext.provide({ scope, fn: task }).catch((error) => {
            log.error("runtime reconciliation failed", { scopeID: scope.id, error })
          })
        })
      }
      const unsubscribeLoop = Bus.subscribe(LoopEvent.Updated, (event) => {
        run(() => LatticeController.onLoopChanged(event.properties.loop))
      })
      const unsubscribeNote = Bus.subscribe(NoteEvent.Updated, (event) => {
        if (!event.properties.changed.includes("content") && !event.properties.changed.includes("archived")) return
        run(() => LatticeController.onBlueprintChanged(event.properties.scopeID, event.properties.note.id))
      })
      const ready = ScopeStartup.resident() ? LatticeController.reconcileScope(scope.id, true) : Promise.resolve()
      return { ready, unsubscribeLoop, unsubscribeNote }
    },
    async (current) => {
      current.unsubscribeLoop()
      current.unsubscribeNote()
      await current.ready.catch(() => undefined)
    },
  )

  /** Subscribe first, then reconcile the persisted fact records once per Scope. */
  export async function init(): Promise<void> {
    await state().ready
  }

  /** Synchronous compatibility seam used by SessionInvoke. */
  export function ensure(): void {
    void state().ready.catch((error) => {
      log.error("initial reconciliation failed", { scopeID: ScopeContext.current.scope.id, error })
    })
  }
}
