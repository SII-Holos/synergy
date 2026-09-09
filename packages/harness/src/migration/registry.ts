import type { Migration } from "./types"

export interface TrackingCompatibility {
  sourceDomain: string
  aliases: Record<string, string>
  rename?(id: string): string
}

const domains = new Map<string, { source: Migration[]; migrations: Migration[]; tracking?: TrackingCompatibility }>()

function snapshot(migrations: Migration[]): Migration[] {
  return migrations.map((migration) => ({
    ...migration,
    ...(migration.dependsOn ? { dependsOn: [...migration.dependsOn] } : {}),
  }))
}
let locked = false

export class MigrationRegistrationLockedError extends Error {
  constructor(readonly domain: string) {
    super(`Register migration domain ${domain} before opening the runtime`)
    this.name = "MigrationRegistrationLockedError"
  }
}

export namespace MigrationRegistry {
  export function register(domain: string, migrations: Migration[], tracking?: TrackingCompatibility): void {
    if (domains.get(domain)?.source === migrations) return
    if (locked) throw new MigrationRegistrationLockedError(domain)
    domains.set(domain, {
      source: migrations,
      migrations: snapshot(migrations),
      tracking: tracking ? { ...tracking, aliases: { ...tracking.aliases } } : undefined,
    })
  }

  export function lock(): void {
    locked = true
  }

  export function unregister(domain: string): void {
    if (locked) throw new MigrationRegistrationLockedError(domain)
    domains.delete(domain)
  }

  export function legacyTracking(): Array<TrackingCompatibility & { targetDomain: string }> {
    return [...domains].flatMap(([targetDomain, entry]) =>
      entry.tracking ? [{ ...entry.tracking, aliases: { ...entry.tracking.aliases }, targetDomain }] : [],
    )
  }

  export function list(): Map<string, Migration[]> {
    return new Map([...domains].map(([domain, entry]) => [domain, snapshot(entry.migrations)]))
  }
}
