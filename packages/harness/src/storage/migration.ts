import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration/types"
import { Storage } from "./storage"
import { StorageArtifactMigration } from "./artifact-migration"

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
]
MigrationRegistry.register("storage", migrations)
