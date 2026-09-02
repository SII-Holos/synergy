import { Log } from "@/util/log"
import { Scope } from "."
import { ScopeContext } from "./context"
import { ScopedState } from "./scoped-state"
import { ScopeStartup } from "./startup"

export namespace ScopeRuntime {
  type StartingListener = (scope: Scope.Project) => void

  const log = Log.create({ service: "scope-runtime" })
  const started = new Map<string, Promise<void>>()
  const disposing = new Map<string, Promise<void>>()
  const startingListeners = new Set<StartingListener>()

  export function onStarting(listener: StartingListener): () => void {
    startingListeners.add(listener)
    return () => startingListeners.delete(listener)
  }

  export async function ensure(scope: Scope): Promise<void> {
    if (scope.type !== "project") return
    await disposing.get(scope.id)
    if (!started.has(scope.id)) {
      started.set(
        scope.id,
        ScopeContext.provide({
          scope,
          fn: async () => {
            log.info("starting", { scopeID: scope.id, type: scope.type, directory: scope.directory })
            await ScopeStartup.run({
              scope,
              notifyStarting(starting) {
                for (const listener of startingListeners) listener(starting)
              },
            })
          },
        }),
      )
    }
    await started.get(scope.id)!
  }

  export async function provide<R>(input: {
    scope: Scope
    fn: () => R | Promise<R>
    workspace?: import("../session/types").Workspace
    ensure?: boolean
  }): Promise<Awaited<R>> {
    if (input.ensure !== false) await ensure(input.scope)
    return ScopeContext.provide(input)
  }

  export async function dispose(scopeID?: string) {
    const id = scopeID ?? ScopeContext.current.scope.id
    const active = disposing.get(id)
    if (active) return active
    const startup = started.get(id)
    started.delete(id)
    const task = Promise.resolve(startup)
      .catch((error) => log.warn("scope startup failed before disposal", { scopeID: id, error }))
      .then(() => ScopeStartup.dispose(id))
      .then(() => ScopedState.dispose(id))
      .finally(() => disposing.delete(id))
    disposing.set(id, task)
    return task
  }

  export async function disposeAll() {
    const ids = [...started.keys()]
    await Promise.all(ids.map((id) => dispose(id)))
    await Promise.all(disposing.values())
    await ScopedState.disposeAll()
  }
}
