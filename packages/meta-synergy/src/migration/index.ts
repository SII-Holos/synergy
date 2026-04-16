import { MetaSynergyStore } from "../state/store"
import { MetaSynergyStateMigrations } from "../state/migration"
import type { MetaSynergyMigration } from "./types"
export type { MetaSynergyMigration } from "./types"

export namespace MetaSynergyMigrationRunner {
  export async function run(): Promise<void> {
    const applied = await MetaSynergyStore.loadMigrationLog()
    const migrations = collect().sort((left, right) => left.id.localeCompare(right.id))

    for (const migration of migrations) {
      if (applied[migration.id]) continue
      await migration.run()
      applied[migration.id] = Date.now()
      await MetaSynergyStore.saveMigrationLog(applied)
    }
  }
}

function collect(): MetaSynergyMigration[] {
  return [...MetaSynergyStateMigrations.migrations]
}
