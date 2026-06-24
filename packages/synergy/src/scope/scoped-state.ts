import { Log } from "@/util/log"
import { GlobalBus } from "@/bus/global"
import { ScopeContext } from "./context"
import { State } from "./state"

export namespace ScopedState {
  const log = Log.create({ service: "scoped-state" })

  export function create<S>(
    init: () => S,
    dispose?: (state: Awaited<S>) => Promise<void>,
  ): (() => S) & { reset: () => Promise<void>; resetAll: () => Promise<void>; peek: () => S | undefined } {
    return State.create(() => ScopeContext.current.scope.id, init, dispose)
  }

  export async function dispose(scopeID?: string) {
    const id = scopeID ?? ScopeContext.current.scope.id
    log.info("disposing scoped state", { scopeID: id })
    await State.dispose(id)
    GlobalBus.emit("event", {
      directory: id === "global" ? "global" : ScopeContext.tryScope()?.directory,
      payload: {
        type: "scope.runtime.disposed",
        properties: {
          scopeID: id,
        },
      },
    })
  }

  export async function disposeAll() {
    log.info("disposing all scoped state")
    await State.disposeAll()
  }
}
