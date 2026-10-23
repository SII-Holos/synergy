import { registerSessionMigrations } from "./session-migration"
import { registerSessionSchema } from "./session-schema"
import { registerLatticeMigrations } from "./lattice/migration"

export function registerMaintenance() {
  registerSessionSchema()
  registerSessionMigrations()
  registerLatticeMigrations()
}
