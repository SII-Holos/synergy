import { spyOn } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"

export function observePollingTimers() {
  const scope = new AsyncLocalStorage<boolean>()
  const active = new Set<unknown>()
  const scheduled = (name: "setTimeout" | "setInterval") => {
    const original = globalThis[name]
    return spyOn(globalThis, name).mockImplementation(
      new Proxy(original, {
        apply(target, receiver, args) {
          const timer = Reflect.apply(target, receiver, args)
          if (scope.getStore()) active.add(timer)
          return timer
        },
      }),
    )
  }
  const cleared = (name: "clearTimeout" | "clearInterval") => {
    const original = globalThis[name]
    return spyOn(globalThis, name).mockImplementation(
      new Proxy(original, {
        apply(target, receiver, args) {
          active.delete(args[0])
          return Reflect.apply(target, receiver, args)
        },
      }),
    )
  }
  const observers = [
    scheduled("setTimeout"),
    scheduled("setInterval"),
    cleared("clearTimeout"),
    cleared("clearInterval"),
  ]
  return {
    run: <T>(body: () => T) => scope.run(true, body),
    count: () => active.size,
    [Symbol.dispose]() {
      for (const observer of observers.reverse()) observer.mockRestore()
      scope.disable()
    },
  }
}
