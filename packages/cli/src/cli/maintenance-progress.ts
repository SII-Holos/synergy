import { AsyncLocalStorage } from "node:async_hooks"
import {
  runtimeStartupLine,
  RuntimeStartupProgress,
  type MigrationStartupTask,
  type StorageMaintenanceEvent,
} from "@ericsanchezok/synergy-util/runtime-startup"
import type { MigrationReporter } from "@ericsanchezok/synergy-harness/migration/types"
import { StorageMaintenance } from "@ericsanchezok/synergy-harness/storage/maintenance"
import { watchManagedParent } from "@ericsanchezok/synergy-harness/util/managed-parent"

export function createManagedMaintenanceReporter(
  write: (line: string) => void = (line) => {
    process.stdout.write(line)
  },
) {
  return (event: StorageMaintenanceEvent) => write(runtimeStartupLine(event))
}

export function createManagedMigrationReporter(
  write: (line: string) => void = (line) => {
    process.stdout.write(line)
  },
): MigrationReporter {
  let step = 0
  let task: MigrationStartupTask | undefined
  return {
    started({ domain, migration }) {
      task = migrationStartupTask(domain, migration.id)
      write(runtimeStartupLine({ phase: "migration", step: ++step, current: 0, total: 0, ...(task && { task }) }))
    },
    progress({ current, total }) {
      if (!RuntimeStartupProgress.safeParse({ phase: "migration", step, current, total }).success) return
      write(runtimeStartupLine({ phase: "migration", step, current, total, ...(task && { task }) }))
    },
    summary() {
      write(runtimeStartupLine({ phase: "starting" }))
    },
  }
}

const migrationTasks = new Map<string, MigrationStartupTask>([
  ["agenda", "scheduled-work"],
  ["blueprint_loop", "blueprints"],
  ["browser", "browser"],
  ["channel", "connections"],
  ["config", "settings"],
  ["note", "notes"],
  ["session", "conversations"],
  ["storage", "storage"],
  ["usage", "usage"],
  ["workflows-session", "workflows"],
  ["scope", "scopes"],
  ["workspace", "workspaces"],
  ["local-workspace", "workspaces"],
])

function migrationStartupTask(domain: string, id: string): MigrationStartupTask | undefined {
  if (domain.startsWith("tool-input-")) return "tool-history"
  if (domain === "session") {
    if (id === "20261001-rollout-attempt-price-evidence") return "request-prices"
    if (id === "20261003-session-turn-file-checkpoints") return "file-history"
  }
  return migrationTasks.get(domain)
}

const context = new AsyncLocalStorage<{ signal: AbortSignal; reporter?: MigrationReporter }>()
export const currentMaintenance = () => context.getStore()

export async function withCliMaintenance<T>(operation: () => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort(new DOMException("Maintenance cancelled at a durable checkpoint", "AbortError"))
  process.on("SIGINT", cancel)
  process.on("SIGTERM", cancel)
  const managed = process.env.SYNERGY_DESKTOP_MAINTENANCE_PROGRESS === "1"
  const stopWatchingParent = managed
    ? watchManagedParent({ expectedParentPid: process.env.SYNERGY_DESKTOP_PARENT_PID, onParentExit: cancel })
    : () => {}
  try {
    return await context.run(
      { signal: controller.signal, reporter: managed ? createManagedMigrationReporter() : undefined },
      () =>
        StorageMaintenance.observe(
          operation,
          managed ? createManagedMaintenanceReporter() : () => {},
          controller.signal,
        ),
    )
  } finally {
    stopWatchingParent()
    process.off("SIGINT", cancel)
    process.off("SIGTERM", cancel)
  }
}
