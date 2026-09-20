import { RuntimeHandle } from "@ericsanchezok/synergy-harness/lifecycle"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"

const open = RuntimeHandle.open
RuntimeHandle.open = (options) =>
  open({
    ...options,
    composition: {
      ...options.composition,
      register() {
        options.composition.register()
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
      },
    },
  })

await import("../../../src/index")
