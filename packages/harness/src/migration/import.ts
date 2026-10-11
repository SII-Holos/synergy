import { RuntimeContext } from "../lifecycle/context"
import { MigrationRegistry } from "./registry"
import { MigrationPlan } from "./plan"
import type { Migration } from "./types"

const runtimeState = RuntimeContext.state(() => ({ imports: { generation: -1, migrations: [] as Migration[] } }))

function importedMigrations(): Migration[] {
  const state = runtimeState().imports
  const generation = MigrationRegistry.generation()
  if (state.generation !== generation) {
    state.migrations = MigrationPlan.ordered(MigrationRegistry.list()).map(({ migration }) => migration)
    state.generation = generation
  }
  return state.migrations
}

export function upgradeImportedConfig(input: Record<string, unknown>): Record<string, unknown>
export function upgradeImportedConfig(input: unknown): unknown
export function upgradeImportedConfig(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const result = structuredClone(input) as Record<string, unknown>
  for (const migration of importedMigrations()) migration.upgradeConfig?.(result)
  return result
}

export function upgradeImportedRecord(key: string[], input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const result = structuredClone(input) as Record<string, unknown>
  for (const migration of importedMigrations()) migration.upgradeRecord?.(key, result)
  return result
}

export function upgradeAccessRecord<T>(key: string[], input: T): T {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const result = structuredClone(input) as Record<string, unknown>
  for (const migration of importedMigrations())
    if (migration.execution === "record") migration.upgradeRecord?.(key, result)
  return result as T
}
