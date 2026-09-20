import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration/types"
import { Storage } from "./storage"
import { StorageArtifactMigration } from "./artifact-migration"
import { StorageDropScopeIndex } from "./drop-scope-index"
import { StorageRecordsOwnerIndex } from "./owner-index"
import { StorageFormatV3Migration } from "./format-v3-migration"
import { StorageIncrementalVacuum } from "./incremental-vacuum"

const migrations: Migration[] = [
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
MigrationRegistry.register("storage", migrations)
