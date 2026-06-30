import { Log } from "@/util/log"
import { Bus } from "@/bus"
import { Command } from "@/command/command"
import { File } from "@/file"
import { Format } from "@/file/format"
import { FileWatcher } from "@/file/watcher"
import { LSP } from "@/lsp"
import { Vcs } from "@/project/vcs"
import { Scope } from "."
import { ScopeContext } from "./context"
import { ScopedState } from "./scoped-state"

export namespace ScopeRuntime {
  const log = Log.create({ service: "scope-runtime" })
  const started = new Map<string, Promise<void>>()

  export async function ensure(scope: Scope): Promise<void> {
    if (scope.type !== "project") return
    if (!started.has(scope.id)) {
      started.set(
        scope.id,
        ScopeContext.provide({
          scope,
          fn: async () => {
            log.info("starting", { scopeID: scope.id, type: scope.type, directory: scope.directory })
            const { Plugin } = await import("@/plugin")
            await Plugin.init()
            Format.init()
            await LSP.init()
            FileWatcher.init()
            File.init()
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
    started.delete(id)
    await ScopedState.dispose(id)
  }

  export async function disposeAll() {
    started.clear()
    await ScopedState.disposeAll()
  }
}
