import { RuntimeContext } from "../lifecycle/context"
import { ScopeContext } from "../scope/context"

export namespace WorkspaceObservation {
  export type Change = { paths: readonly string[] | null; available?: boolean }
  type Listener = (change: Change) => void
  const state = RuntimeContext.state(() => ({
    watch: undefined as (() => Promise<boolean>) | undefined,
    listeners: new Map<string, Set<Listener>>(),
  }))
  function key() {
    const { scope, workspace } = ScopeContext.current
    if (!workspace?.id) return
    return JSON.stringify([scope.id, workspace.id, workspace.generation])
  }
  export function register(watch: () => Promise<boolean>) {
    RuntimeContext.assertCompositionOpen("Workspace observation")
    state().watch = watch
  }
  export async function subscribe(listener: Listener) {
    const id = key()
    if (!id || !state().watch) return { available: false, close() {} }
    const listeners = state().listeners.get(id) ?? new Set<Listener>()
    state().listeners.set(id, listeners)
    listeners.add(listener)
    const close = () => {
      listeners.delete(listener)
      if (!listeners.size) state().listeners.delete(id)
    }
    try {
      return { available: await state().watch!(), close }
    } catch (error) {
      close()
      throw error
    }
  }
  export function invalidate(change: Change) {
    const id = key()
    if (id) for (const listener of state().listeners.get(id) ?? []) listener(change)
  }
}
