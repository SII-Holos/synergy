import type { Info } from "./types"
/**
 * S9c source inversion (Blueprint): product domains contribute advisory
 * environment hint lines to the session environment prompt through this
 * registry instead of session importing them. The L4 product manifest
 * registers contributors (superplan today); unregistered contributors
 * contribute nothing.
 */
export namespace SessionEnvContributor {
  /** Session fields available to environment-hint contributors. */
  export type EnvSession = Partial<Omit<Info, "time">> & { time?: { created: number } }

  export interface Contributor {
    id: string
    /** Indented env-block lines (leading two spaces included). */
    envHints(session?: EnvSession): Promise<string[]>
  }

  const contributors = new Map<string, Contributor>()

  export function register(contributor: Contributor): void {
    contributors.set(contributor.id, contributor)
  }

  export function list(): Contributor[] {
    return [...contributors.values()]
  }
}
