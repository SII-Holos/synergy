import { SynergyLinkStore } from "../state/store"
import { SynergyLinkStateMigrations } from "../state/migration"
import type { SynergyLinkMigration } from "./types"
export type { SynergyLinkMigration } from "./types"

export namespace SynergyLinkMigrationRunner {
  export async function run(): Promise<void> {
    let applied = await SynergyLinkStore.loadMigrationLog()
    const migrations = collect().sort((left, right) => left.id.localeCompare(right.id))

    for (const migration of migrations) {
      if (applied[migration.id]) continue
      await migration.run()
      applied = {
        ...applied,
        ...(await SynergyLinkStore.loadMigrationLog()),
        [migration.id]: Date.now(),
      }
      await SynergyLinkStore.saveMigrationLog(applied)
    }
  }
}

function collect(): SynergyLinkMigration[] {
  return [...SynergyLinkStateMigrations.migrations]
}
