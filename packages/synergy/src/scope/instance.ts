import { Log } from "@/util/log"
import { Context } from "../util/context"
import { Scope } from "."
import { State } from "./state"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"

const scopeContext = Context.create<Scope>("instance")
const workspaceContext = Context.create<import("../session/types").Workspace>("instance.workspace")
const cache = new Map<string, Promise<Scope>>()

function instanceKey(scope: Scope): string {
  return scope.id
}

export const Instance = {
  async provide<R>(input: {
    scope: Scope
    init?: () => Promise<any>
    fn: () => R
    workspace?: import("../session/types").Workspace
  }): Promise<R> {
    const key = instanceKey(input.scope)
    if (!cache.has(key)) {
      Log.Default.info("creating instance", { scopeID: input.scope.id, type: input.scope.type })
      cache.set(
        key,
        iife(async () => {
          await scopeContext.provide(input.scope, async () => {
            await input.init?.()
          })
          return input.scope
        }),
      )
    }
    await cache.get(key)!
    return scopeContext.provide(input.scope, async () => {
      if (input.workspace) {
        return workspaceContext.provide(input.workspace, input.fn)
      }
      return input.fn()
    })
  },
  get scope(): Scope {
    return scopeContext.use()
  },
  get directory() {
    const ws = workspaceContext.tryUse()
    return ws?.path ?? scopeContext.use().directory
  },
  get workspace(): import("../session/types").Workspace | undefined {
    return workspaceContext.tryUse()
  },
  get worktree() {
    return scopeContext.use().worktree
  },
  contains(targetPath: string): boolean {
    return Scope.contains(scopeContext.use(), targetPath)
  },
  state<S>(
    init: () => S,
    dispose?: (state: Awaited<S>) => Promise<void>,
  ): (() => S) & { reset: () => Promise<void>; resetAll: () => Promise<void>; peek: () => S | undefined } {
    return State.create(() => instanceKey(Instance.scope), init, dispose)
  },
  async dispose() {
    const scope = scopeContext.use()
    const key = instanceKey(scope)
    Log.Default.info("disposing instance", { scopeID: scope.id })
    await State.dispose(key)
    cache.delete(key)
    GlobalBus.emit("event", {
      directory: scope.type === "global" ? "global" : scope.directory,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory: scope.type === "global" ? "global" : scope.directory,
        },
      },
    })
  },
  async disposeAll() {
    Log.Default.info("disposing all instances")
    for (const [_key, value] of cache) {
      const awaited = await value.catch(() => {})
      if (awaited) {
        await scopeContext.provide(awaited, async () => {
          await Instance.dispose()
        })
      }
    }
    cache.clear()
  },
}
