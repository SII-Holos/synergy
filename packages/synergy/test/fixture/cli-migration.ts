import "../../src/product-registration"
import "../../src/migration"
import { MigrationRegistry } from "../../src/migration/registry"

MigrationRegistry.register("aaa-cli-progress-fixture", [
  {
    id: "cli-progress-fixture",
    description: "Upgrade CLI fixture records",
    async up(progress) {
      progress(1, 2)
      throw new Error("CLI fixture stops before runtime admission")
    },
  },
])

await import("../../src/main")
