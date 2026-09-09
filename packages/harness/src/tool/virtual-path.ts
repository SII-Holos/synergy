export namespace BashVirtualPath {
  const providerPatterns = {
    note: /^\/synergy\/note\/(nte_[A-Za-z0-9_-]+)$/,
  } as const

  export type Provider = keyof typeof providerPatterns

  export interface Match {
    provider: Provider
    id: string
  }

  export function match(value: string): Match | undefined {
    for (const [provider, pattern] of Object.entries(providerPatterns) as [Provider, RegExp][]) {
      const id = pattern.exec(value)?.[1]
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
