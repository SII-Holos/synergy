import fs from "node:fs/promises"
import { RuntimeContext } from "../lifecycle/context"
import { Log } from "../util/log"
import { Scope } from "."
import { ScopeContext } from "./context"
import { ScopedState } from "./scoped-state"
import { ScopeStartup } from "./startup"
import { WorkspaceRuntime } from "../workspace/runtime"

export namespace ScopeRuntime {
  type StartingListener = (scope: Scope.Project) => void

  const log = Log.create({ service: "scope-runtime" })
  const runtimeState = RuntimeContext.state(() => ({
    stopped: false,
    disposal: undefined as Promise<void> | undefined,
    started: new Map<string, Promise<void>>(),
    disposing: new Map<string, Promise<void>>(),
    startingListeners: new Set<StartingListener>(),
  }))

  export function onStarting(listener: StartingListener): () => void {
    const instanceState = runtimeState()

    instanceState.startingListeners.add(listener)
    return () => instanceState.startingListeners.delete(listener)
  }

  export async function ensure(scope: Scope): Promise<void> {
    const instanceState = runtimeState()

    if (scope.type !== "project" || !scope.local || scope.time.archived) return
    if (
      !(await fs.stat(scope.local.directory).then(
        (stat) => stat.isDirectory(),
        () => false,
      ))
    )
      return
    await instanceState.disposal
    await instanceState.disposing.get(scope.id)
    if (instanceState.stopped) throw new Error("Scope runtime is stopping")
    if (!instanceState.started.has(scope.id)) {
      instanceState.started.set(
        scope.id,
        ScopeContext.provide({
          scope,
          fn: async () => {
            log.info("starting", { scopeID: scope.id, type: scope.type, directory: scope.local?.directory })
            await ScopeStartup.run({
              scope,
              notifyStarting(starting) {
                for (const listener of instanceState.startingListeners) listener(starting)
              },
            })
          },
        }).catch(async (error) => {
          try {
            await ScopedState.dispose(scope.id)
          } finally {
            instanceState.started.delete(scope.id)
          }
          throw error
        }),
      )
    }
    await instanceState.started.get(scope.id)!
  }

  export async function provide<R>(input: {
    scope: Scope
    fn: () => R | Promise<R>
    workspace?: import("../session/types").Workspace | null
    ensure?: boolean
  }): Promise<Awaited<R>> {
    if (input.ensure !== false) await ensure(input.scope)
    return ScopeContext.provide({
      ...input,
      fn: async () => {
        const workspace = ScopeContext.current.workspace
        if (input.ensure !== false && workspace) await WorkspaceRuntime.ensure(input.scope, workspace)
        return input.fn()
      },
    })
  }

  export async function dispose(scopeID?: string) {
    const instanceState = runtimeState()

    const id = scopeID ?? ScopeContext.current.scope.id
    const active = instanceState.disposing.get(id)
    if (active) return active
    const startup = instanceState.started.get(id)
    instanceState.started.delete(id)
    const task = Promise.resolve(startup)
      .catch((error) => log.warn("scope startup failed before disposal", { scopeID: id, error }))
      .then(async () => {
        const errors: unknown[] = []
        for (const dispose of [
          () => WorkspaceRuntime.disposeScope(id),
          () => ScopeStartup.dispose(id),
          () => ScopedState.dispose(id),
        ]) {
          try {
            await dispose()
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length) throw new AggregateError(errors, "Scope cleanup failed")
      })
      .finally(() => instanceState.disposing.delete(id))
    instanceState.disposing.set(id, task)
    return task
  }

  export function stop() {
    runtimeState().stopped = true
    WorkspaceRuntime.stop()
    return disposeAll()
  }

  export function disposeAll(): Promise<void> {
    const state = runtimeState()
    return (state.disposal ??= (async () => {
      const results = await Promise.allSettled([...state.started.keys()].map((id) => dispose(id)))
      results.push(...(await Promise.allSettled(state.disposing.values())))
      results.push(...(await Promise.allSettled([WorkspaceRuntime.disposeAll()])))
      results.push(...(await Promise.allSettled([ScopedState.disposeAll()])))
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (errors.length) throw new AggregateError(errors, "Scope resources cleanup failed")
    })().finally(() => {
      state.disposal = undefined
    }))
  }
}
