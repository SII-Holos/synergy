import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration/types"
import { Storage } from "./storage"
import { StorageArtifactMigration } from "./artifact-migration"
import { StorageIncrementalVacuum } from "./incremental-vacuum"

const migrations: Migration[] = [
  {
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
    id: StorageIncrementalVacuum.id,
    description: "Convert authoritative SQLite storage to incremental auto-vacuum",
    domain: "storage",
    async up(progress) {
      progress(0, 0, 1)
      await StorageIncrementalVacuum.run(progress)
      progress(1, 1, 2)
    },
  },
]
MigrationRegistry.register("storage", migrations)
