import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration"

export const migrations: Migration[] = []

MigrationRegistry.register("blueprint_loop", migrations)
