import { Bus } from "@/bus"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { ScopeStartup } from "@/scope/startup"
import { Command } from "./command"

const unsubscribers = new Map<string, () => void>()

/**
 * H5 command startup contribution: the scope-initialization watcher (mark a
 * scope initialized once its INIT command executed) moves out of
 * scope/runtime.ts into the command domain. The subscription callback
 * resolves the ambient scope at event time, exactly as the historical
 * ScopedState-based watcher did; dispose unsubscribes per scope.
 */
export function registerCommandStartup() {
  ScopeStartup.register({
    name: "command-watcher",
    phase: "surface",
    after: ["vcs-init"],
    init(scope) {
      const unsubscribe = Bus.subscribe(Command.Event.Executed, async (payload) => {
        if (payload.properties.name === Command.Default.INIT) {
          await Scope.setInitialized(ScopeContext.current.scope.id)
        }
      })
      unsubscribers.set(scope.id, unsubscribe)
    },
    dispose(scopeID) {
      unsubscribers.get(scopeID)?.()
      unsubscribers.delete(scopeID)
    },
  })
}
