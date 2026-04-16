import { readFile } from "node:fs/promises"
import { MetaSynergyStore } from "./store"
import type { MetaSynergyMigration } from "../migration/types"

export namespace MetaSynergyStateMigrations {
  export const migrations: MetaSynergyMigration[] = [
    {
      id: "20260408-normalize-state",
      description: "Normalize persisted meta-synergy state",
      async run() {
        const raw = await readFile(MetaSynergyStore.statePath(), "utf8").catch(() => undefined)
        if (!raw) return
        const parsed = JSON.parse(raw) as unknown
        const next = MetaSynergyStore.hydrateStateForMigration(parsed)
        await MetaSynergyStore.saveState(next)
      },
    },
  ]
}
