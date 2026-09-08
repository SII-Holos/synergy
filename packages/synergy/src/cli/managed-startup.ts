import { runtimeStartupLine } from "@ericsanchezok/synergy-util/runtime-startup"
import type { MigrationReporter } from "../migration/types"

export function createManagedMigrationReporter(
  write: (line: string) => void = (line) => {
    process.stdout.write(line)
  },
): MigrationReporter {
  let step = 0
  return {
    started() {
      write(runtimeStartupLine({ phase: "migration", step: ++step, current: 0, total: 0 }))
    },
    progress({ current, total }) {
      if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total) || current < 0 || total < current) return
      write(runtimeStartupLine({ phase: "migration", step, current, total }))
    },
    summary() {
      write(runtimeStartupLine({ phase: "starting" }))
    },
  }
}
