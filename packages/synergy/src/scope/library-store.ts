/**
 * S9d library store port: the scope migrations touch library experience data
 * (scope enumeration, orphan cleanup, legacy scope rename) through this
 * registered source instead of importing the library product domain. The L4
 * product manifest registers the concrete store; unregistered, migrations
 * skip the library side and move only file-based data.
 */
export namespace ScopeLibraryStore {
  export interface Source {
    /** All scope IDs referenced by stored experiences; empty when no library DB exists. */
    experienceScopeIDs(): string[]
    removeExperiencesByScope(scopeID: string): number
    renameExperienceScope(fromScopeID: string, toScopeID: string): number
  }

  let source: Source | undefined

  export function register(value: Source): void {
    source = value
  }

  export function get(): Source | undefined {
    return source
  }
}
