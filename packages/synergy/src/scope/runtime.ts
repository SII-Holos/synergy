import { Log } from "@/util/log"
import { Bus } from "@/bus"
import { Command } from "@/command/command"
import { Format } from "@/file/format"
import { FileWatcher } from "@/file/watcher"
import { LSP } from "@/lsp"
import { Plugin } from "@/plugin"
import { Vcs } from "@/project/vcs"
import { SessionRecovery } from "@/session/recovery"
import { SessionInvoke } from "@/session/invoke"
import { LatticeRuntime } from "@/lattice/runtime"
import { Scope } from "."
import { ScopeContext } from "./context"
import { ScopedState } from "./scoped-state"

export namespace ScopeRuntime {
  const log = Log.create({ service: "scope-runtime" })
  const started = new Map<string, Promise<void>>()
  const disposing = new Map<string, Promise<void>>()

  export async function ensure(scope: Scope): Promise<void> {
    if (scope.type !== "project") return
    await disposing.get(scope.id)
    if (!started.has(scope.id)) {
      started.set(
        scope.id,
        ScopeContext.provide({
          scope,
          fn: async () => {
            Plugin.activateScope(scope.id)
            log.info("starting", { scopeID: scope.id, type: scope.type, directory: scope.directory })
            await Plugin.init()
            await SessionRecovery.reconcileRuntimeState({ scopeID: scope.id, apply: true }).catch((error) => {
              log.warn("session runtime recovery failed", { scopeID: scope.id, error })
            })
            await LatticeRuntime.init()
            await SessionInvoke.resumePending({ scopeID: scope.id })
            Format.init()
            await LSP.init()
            FileWatcher.init()
            Vcs.init()
            const commandState = ScopedState.create(
              () => {
                const unsub = Bus.subscribe(Command.Event.Executed, async (payload) => {
                  if (payload.properties.name === Command.Default.INIT) {
                    await Scope.setInitialized(ScopeContext.current.scope.id)
                  }
                })
                return { unsub }
              },
              async (s) => s.unsub(),
            )
            void commandState()
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
      .then(() => Plugin.disposeScope(id))
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
