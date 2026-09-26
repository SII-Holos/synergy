import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration/types"
import { StorageCompat } from "./compat"
import { Storage } from "./storage"
import { StorageArtifactMigration } from "./artifact-migration"
import { StorageDropScopeIndex } from "./drop-scope-index"
import { StorageRecordsOwnerIndex } from "./owner-index"
import { StorageFormatV3Migration } from "./format-v3-migration"
import { StorageIncrementalVacuum } from "./incremental-vacuum"
import { StorageFormatV3State } from "./format-v3-state"

const migrations: Migration[] = [
  {
    id: "20260921-format-v3-maintenance-state",
    scope: "global",
    execution: "startup",
    description: "Separate committed format upgrades from resumable space reclamation",
    async up() {
      const store = Storage.current().store
      const state = await StorageFormatV3State.read(store)
      if (!state) return
      await StorageFormatV3State.update(store, (current) => ({
        ...current,
        paused: current.paused ?? false,
        releasedPages: current.releasedPages ?? 0,
        invalidated: current.invalidated || (!current.fenced && store.keyEncodedAs === "hex"),
      }))
    },
  },
  {
    id: "20260921-pending-owner-admission",
    scope: "global",
    execution: "startup",
    description: "Protect unpublished historical records from business access",
    async up() {
      const store = Storage.current().store
      for await (const locator of StorageCompat.catalog(store)) {
        if (locator.status !== "imported")
          await store.write(["compat_pending", locator.sessionID], { scopeID: locator.scopeID })
      }
    },
  },
  {
    scope: "global",
    id: StorageArtifactMigration.id,
    description: "Pack legacy rollout artifacts with transactional byte references",
    async up(progress) {
      const handle = Storage.current()
      let stage = "",
        phase = 0
      await StorageArtifactMigration.run({
        dataRoot: handle.artifactDirectory,
        store: handle.store,
        progress(value) {
          if (value.stage !== stage) {
            stage = value.stage
            phase++
            progress(0, 0, phase)
          }
          progress(value.current, value.total, phase)
        },
      })
      progress(1, 1, phase + 1)
    },
  },
  {
    scope: "global",
    id: StorageIncrementalVacuum.id,
    execution: "maintenance",
    isApplied: () => Storage.current().store.incrementalVacuumEnabled(),
    description: "Convert authoritative SQLite storage to incremental auto-vacuum",
    domain: "storage",
    async up(progress) {
      progress(0, 0, 1)
      await StorageIncrementalVacuum.run(progress)
      progress(1, 1, 2)
    },
  },
  {
    id: StorageDropScopeIndex.id,
    scope: "global",
    execution: "startup",
    description: "Drop the retired storage_records_scope index",
    domain: "storage",
    async up(progress) {
      progress(0, 0, 1)
      await StorageDropScopeIndex.run()
      progress(1, 1, 1)
    },
  },
  {
    id: StorageRecordsOwnerIndex.id,
    scope: "global",
    execution: "startup",
    description: "Create the storage_records_owner evidence enumeration index",
    domain: "storage",
    async up(progress) {
      progress(0, 0, 1)
      await StorageRecordsOwnerIndex.run()
      progress(1, 1, 1)
    },
  },
  {
    id: StorageFormatV3Migration.id,
    scope: "global",
    execution: "maintenance",
    dependsOn: [StorageIncrementalVacuum.id],
    isApplied: () => StorageFormatV3Migration.isApplied(Storage.current().store),
    description: "Rewrite records, nodes and artifact locators into the format 3 layout",
    domain: "storage",
    async up(progress) {
      progress(0, 0, 1)
      await StorageFormatV3Migration.run({
        store: Storage.current().store,
        progress: (current, total, phase) => progress(current, total, phase),
      })
    },
  },
]
export function registerStorageMigrations() {
  MigrationRegistry.register("storage", migrations)
}
