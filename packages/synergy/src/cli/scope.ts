import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { ScopeRuntime } from "@/scope/runtime"

export async function resolveCliScope(input: { fallbackDirectory: string; scopeID?: string }): Promise<Scope> {
  if (!input.scopeID) return (await Scope.fromDirectory(input.fallbackDirectory)).scope
  const scope = await Scope.fromID(input.scopeID)
  if (!scope) throw new Error(`Scope not found: ${input.scopeID}`)
  return scope
}

export async function withScopeContext<T>(
  fallbackDirectory: string,
  fn: () => Promise<T>,
  scopeID?: string,
): Promise<T> {
  const scope = await resolveCliScope({ fallbackDirectory, scopeID })
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
