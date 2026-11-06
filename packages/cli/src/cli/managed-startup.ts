import {
  runtimeStartupLine,
  type RuntimeStartupEvent,
  type StorageStartupProgress,
} from "@ericsanchezok/synergy-util/runtime-startup"
export {
  createManagedMaintenanceReporter,
  createManagedMigrationReporter,
} from "@ericsanchezok/synergy-cli/cli/maintenance-progress"

export function createManagedStartupReporter(
  write: (line: string) => void = (line) => {
    process.stdout.write(line)
  },
  now: () => number = Date.now,
) {
  let previous: RuntimeStartupEvent | undefined
  let emittedAt = -Infinity
  return (event: RuntimeStartupEvent) => {
    if (previous?.state === "ready" || previous?.state === "failed") return
    const time = now()
    if (event.state === "opening" && previous?.state === "opening" && event.stage === previous.stage) {
      if ((event.current ?? 0) <= (previous.current ?? 0) || time - emittedAt < 250) return
    }
    previous = event
    emittedAt = time
    write(runtimeStartupLine(event))
  }
}

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

export function createManagedStorageReporter(
  write: (line: string) => void = (line) => {
    process.stdout.write(line)
  },
  now: () => number = Date.now,
) {
  let step = 0
  let stage: StorageStartupProgress["stage"] | undefined
  let emittedAt = -Infinity
  let previous: StorageStartupProgress | undefined
  return (progress: StorageStartupProgress) => {
    const changed = stage !== progress.stage
    if (changed) {
      stage = progress.stage
      step++
    }
    const time = now()
    const discovered =
      previous?.total === 0 &&
      progress.total > 0 &&
      progress.current >= previous.current &&
      progress.bytes >= previous.bytes
    if (!changed && !discovered && previous && progress.current <= previous.current && progress.bytes <= previous.bytes)
      return
    if (
      !changed &&
      !discovered &&
      time - emittedAt < 250 &&
      (progress.total === 0 || progress.current !== progress.total)
    )
      return
    previous = progress
    emittedAt = time
    write(runtimeStartupLine({ phase: "storage", step, ...progress }))
  }
}
