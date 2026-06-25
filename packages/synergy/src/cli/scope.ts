import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { ScopeRuntime } from "@/scope/runtime"

export async function withScopeContext<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const scope = (await Scope.fromDirectory(directory)).scope
  return ScopeContext.provide({ scope, fn })
}

export async function withScopeRuntime<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const scope = (await Scope.fromDirectory(directory)).scope
  return ScopeRuntime.provide({
    scope,
    fn: async () => {
      try {
        return await fn()
      } finally {
        await ScopeRuntime.dispose(scope.id)
      }
    },
  })
}
