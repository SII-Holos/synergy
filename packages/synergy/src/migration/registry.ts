import type { Migration } from "./types"

const domains = new Map<string, Migration[]>()

export namespace MigrationRegistry {
  export function register(domain: string, migrations: Migration[]): void {
    domains.set(domain, migrations)
  }

  export function list(): Map<string, Migration[]> {
    return domains
  }
}
