import { runtimeStartupLine } from "@ericsanchezok/synergy-util/runtime-startup"
import type { MigrationReporter } from "@ericsanchezok/synergy-harness/migration/types"

export function createManagedRecoveryReporter(
  write: (line: string) => void = (line) => {
    process.stdout.write(line)
  },
  now: () => number = Date.now,
) {
  let emittedAt = -Infinity
  let previous = -1
  return {
    progress(current: number) {
      if (!Number.isSafeInteger(current) || current <= previous) return
      const time = now()
      if (time - emittedAt < 250) return
      previous = current
      emittedAt = time
      write(runtimeStartupLine({ phase: "recovery", current }))
    },
    completed() {
      write(runtimeStartupLine({ phase: "starting" }))
    },
  }
}

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
