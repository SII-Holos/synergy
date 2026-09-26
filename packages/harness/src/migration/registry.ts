import { RuntimeContext } from "../lifecycle/context"
import type { Migration } from "./types"

export interface TrackingCompatibility {
  sourceDomain: string
  aliases: Record<string, string>
  rename?(id: string): string
}

const runtimeState = RuntimeContext.state(() => ({
  domains: new Map<string, { source: Migration[]; migrations: Migration[]; tracking?: TrackingCompatibility }>(),
  locked: false,
}))

function snapshot(migrations: Migration[]): Migration[] {
  return migrations.map((migration) => ({
    ...migration,
    ...(migration.dependsOn ? { dependsOn: [...migration.dependsOn] } : {}),
  }))
}

export class MigrationRegistrationLockedError extends Error {
  constructor(readonly domain: string) {
    super(`Register migration domain ${domain} before opening the runtime`)
    this.name = "MigrationRegistrationLockedError"
  }
}

export namespace MigrationRegistry {
  export function register(domain: string, migrations: Migration[], tracking?: TrackingCompatibility): void {
    const instanceState = runtimeState()

    const existing = instanceState.domains.get(domain)
    if (existing?.source === migrations) return
    if (existing) throw new Error(`Migration domain ${domain} is already registered`)
    if (instanceState.locked) throw new MigrationRegistrationLockedError(domain)
    instanceState.domains.set(domain, {
      source: migrations,
      migrations: snapshot(migrations),
      tracking: tracking ? { ...tracking, aliases: { ...tracking.aliases } } : undefined,
    })
  }

  export function lock(): void {
    const instanceState = runtimeState()

    instanceState.locked = true
  }

  export function unregister(domain: string): void {
    const instanceState = runtimeState()

    if (instanceState.locked) throw new MigrationRegistrationLockedError(domain)
    instanceState.domains.delete(domain)
  }

  export function legacyTracking(): Array<TrackingCompatibility & { targetDomain: string }> {
    const instanceState = runtimeState()

    return [...instanceState.domains].flatMap(([targetDomain, entry]) =>
      entry.tracking ? [{ ...entry.tracking, aliases: { ...entry.tracking.aliases }, targetDomain }] : [],
    )
  }

  export function list(): Map<string, Migration[]> {
    const instanceState = runtimeState()

    return new Map([...instanceState.domains].map(([domain, entry]) => [domain, snapshot(entry.migrations)]))
  }
}
