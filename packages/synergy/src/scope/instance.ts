import { Log } from "@/util/log"
import { Context } from "../util/context"
import { Scope } from "."
import { State } from "./state"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"

const context = Context.create<Scope>("instance")
const cache = new Map<string, Promise<Scope>>()

function instanceKey(scope: Scope): string {
  return scope.id
}

export const Instance = {
  async provide<R>(input: { scope: Scope; init?: () => Promise<any>; fn: () => R }): Promise<R> {
    const key = instanceKey(input.scope)
    if (!cache.has(key)) {
      Log.Default.info("creating instance", { scopeID: input.scope.id, type: input.scope.type })
      cache.set(
        key,
        iife(async () => {
          await context.provide(input.scope, async () => {
            await input.init?.()
          })
          return input.scope
        }),
      )
    }
    await cache.get(key)!
    return context.provide(input.scope, async () => {
      return input.fn()
    })
  },
  get scope(): Scope {
    return context.use()
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  contains(targetPath: string): boolean {
    return Scope.contains(context.use(), targetPath)
  },
  state<S>(
    init: () => S,
    dispose?: (state: Awaited<S>) => Promise<void>,
  ): (() => S) & { reset: () => Promise<void>; resetAll: () => Promise<void>; peek: () => S | undefined } {
    return State.create(() => instanceKey(Instance.scope), init, dispose)
  },
  async dispose() {
    const scope = context.use()
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
        await context.provide(awaited, async () => {
          await Instance.dispose()
        })
      }
    }
    cache.clear()
  },
}
