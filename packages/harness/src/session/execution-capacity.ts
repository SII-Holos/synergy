import { RuntimeContext } from "../lifecycle/context"

export namespace ExecutionCapacity {
  export interface Owner {
    pause(): void
    resume(): Promise<void>
    fork?(): Owner & { finish(): void }
  }
  const sessions = RuntimeContext.state(() => new Map<string, Owner>())
  const context = RuntimeContext.createAsyncContext<ReadonlyMap<string, Owner>>()

  export function provide<T>(kind: "tool" | "cortex", owner: Owner, fn: () => T): T {
    return context.run(new Map([...(context.getStore() ?? []), [kind, owner]]), fn)
  }

  export function registerSession(sessionID: string, owner: Owner) {
    const current = sessions()
    if (current.has(sessionID)) throw new Error("Session already owns execution capacity")
    current.set(sessionID, owner)
    return () => {
      if (current.get(sessionID) === owner) current.delete(sessionID)
    }
  }

  export function session<T>(sessionID: string, fn: () => T): T {
    return detached(() => {
      const owner = sessions().get(sessionID)
      return owner ? provide("cortex", owner, fn) : fn()
    })
  }

  export async function tool<T>(owner: Owner, fn: () => Promise<T>): Promise<T> {
    const branch = context.getStore()?.get("cortex")?.fork?.()
    if (!branch) return provide("tool", owner, fn)
    try {
      await detached(() => provide("tool", owner, () => wait(() => branch.resume())))
      return await provide("cortex", branch, () => provide("tool", owner, fn))
    } finally {
      branch.finish()
    }
  }

  export function detached<T>(fn: () => T): T {
    return context.run(new Map(), fn)
  }

  export async function wait<T>(fn: () => Promise<T>): Promise<T> {
    const owners = [...(context.getStore()?.values() ?? [])]
    for (const owner of owners) owner.pause()
    try {
      return await detached(fn)
    } finally {
      const errors: unknown[] = []
      for (const owner of owners.reverse()) {
        try {
          await owner.resume()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) throw errors[0]
    }
  }
}
