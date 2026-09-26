import { ScopeContext } from "../scope/context"
import { RuntimeContext } from "../lifecycle/context"
import { ScopedState } from "../scope/scoped-state"

export namespace Env {
  const state = ScopedState.create(() => {
    return { ...RuntimeContext.current().host.env }
  })

  export function get(key: string) {
    return ScopeContext.tryScope() ? state()[key] : RuntimeContext.current().host.env[key]
  }

  export function all() {
    return ScopeContext.tryScope() ? state() : { ...RuntimeContext.current().host.env }
  }

  export function set(key: string, value: string) {
    const env = state()
    env[key] = value
  }

  export function remove(key: string) {
    const env = state()
    delete env[key]
  }
}
