import { RuntimeContext } from "../lifecycle/context"

export namespace BashVirtualPath {
  export interface Source {
    extension: string
    match(value: string): string | undefined
    read(scopeID: string, id: string): Promise<string>
  }

  const runtimeState = RuntimeContext.state(() => new Map<string, Readonly<Source>>())

  export function register(provider: string, source: Source) {
    RuntimeContext.assertCompositionOpen("virtual file providers")
    if (!/^[a-z][a-z0-9-]*$/.test(provider) || !/^\.[a-z0-9]+$/i.test(source.extension))
      throw new Error("Invalid virtual file provider")
    const sources = runtimeState()
    if (sources.has(provider)) throw new Error(`Duplicate virtual file provider: ${provider}`)
    sources.set(provider, Object.freeze({ ...source }))
  }

  export function source(provider: string) {
    const source = runtimeState().get(provider)
    if (!source) throw new Error(`Virtual file provider is not registered: ${provider}`)
    return source
  }

  export interface Match {
    provider: string
    id: string
  }

  export function match(value: string): Match | undefined {
    for (const [provider, source] of runtimeState()) {
      const id = source.match(value)
      if (id) return { provider, id }
    }
  }

  export function is(value: string): boolean {
    return match(value) !== undefined
  }

  export function isShellCandidate(value: string): boolean {
    return is(value.replace(/[`)]+$/, ""))
  }
}
