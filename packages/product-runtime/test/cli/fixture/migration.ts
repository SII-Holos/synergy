import "../../../src/product-registration"
import "@ericsanchezok/synergy-harness/migration"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"

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

await import("../../../src/index")
