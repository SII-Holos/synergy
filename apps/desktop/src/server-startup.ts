import {
  RUNTIME_STARTUP_MAX_LINE_LENGTH,
  RUNTIME_STARTUP_PREFIX,
  RuntimeStartupProgress,
  RuntimeStartupStage,
  type RuntimeStartupEvent,
  type StorageMaintenanceEvent,
  type StorageMaintenanceOperation,
  StorageMaintenanceStage,
  type MigrationStartupTask,
} from "@ericsanchezok/synergy-util/runtime-startup"
import type { DesktopStartupStatus } from "./startup-page.js"

type WorkProgress = Exclude<RuntimeStartupProgress, StorageMaintenanceEvent | RuntimeStartupEvent>
const runtimeLabels: Record<RuntimeStartupStage, string> = {
  initializing: "Preparing the runtime.",
  storage: "Opening saved data.",
  migrations: "Updating saved data.",
  "storage-recovery": "Restoring saved data.",
  configuration: "Loading settings.",
  "execution-recovery": "Restoring saved work.",
  extensions: "Initializing extensions.",
  transport: "Opening the local server.",
  services: "Starting background services.",
  finalizing: "Finishing runtime startup.",
}

type Maintenance = {
  operation: StorageMaintenanceOperation
  stage?: StorageMaintenanceStage
  startedAt: number
  deadline: number
  timeoutMs: number
}
const maintenanceLabels: Record<StorageMaintenanceOperation, string> = {
  vacuum: "Rebuilding the database.",
  reclaim: "Reclaiming database space.",
  prune: "Removing expired execution evidence.",
  "integrity-check": "Checking database integrity.",
  "create-index": "Building a database index.",
  "drop-index": "Removing a retired database index.",
}
const maintenanceStages: Record<StorageMaintenanceStage, string> = {
  "checkpoint-before": "Preparing the database journal.",
  rewrite: "Rebuilding the database.",
  "checkpoint-after": "Finishing the database journal.",
}
const migrationLabels: Record<MigrationStartupTask, string> = {
  "scheduled-work": "Preparing scheduled tasks.",
  blueprints: "Preparing saved blueprints.",
  browser: "Preparing browser pages and profiles.",
  connections: "Preparing saved connections.",
  settings: "Updating saved settings.",
  notes: "Preparing saved notes.",
  conversations: "Updating saved conversations.",
  "request-prices": "Preserving historical request prices.",
  "file-history": "Preparing saved file history.",
  "tool-history": "Updating saved tool history.",
  usage: "Preparing usage history.",
  workflows: "Preparing saved workflows.",
  scopes: "Preparing saved work contexts.",
  workspaces: "Preparing saved workspaces.",
  storage: "Preparing saved records.",
}

export class DesktopServerStartup {
  private buffer = ""
  private discarded = false
  private progress: WorkProgress | undefined
  private runtimeStage?: RuntimeStartupStage
  private runtimeCurrent = 0
  private ready = false
  private readonly maintenance = new Map<number, Maintenance>()
  private maintenanceSequence = 0
  private failure?: Error
  private recoveryCompleted = false
  private storageStep = 0
  private deadline: number
  private readonly now: () => number
  private readonly healthTimeoutMs: number
  private readonly migrationIdleMs: number
  private readonly startedAt: number
  private stepStartedAt: number
  private lastProgressAt: number
  private presentationPhase: NonNullable<DesktopStartupStatus["phase"]> = "storage"

  constructor(
    private readonly options: {
      now?: () => number
      healthTimeoutMs?: number
      migrationIdleMs?: number
      mode?: "server" | "maintenance"
      onStatus?: (status: DesktopStartupStatus) => void
      onProgress?: (progress: WorkProgress) => void
    } = {},
  ) {
    this.now = options.now ?? (() => performance.now())
    this.healthTimeoutMs = options.healthTimeoutMs ?? 30_000
    this.migrationIdleMs = options.migrationIdleMs ?? 5 * 60_000
    this.startedAt = this.now()
    this.stepStartedAt = this.startedAt
    this.lastProgressAt = this.startedAt
    this.deadline = this.startedAt + this.healthTimeoutMs
  }

  receive(chunk: string): void {
    for (const [index, part] of chunk.split("\n").entries()) {
      if (index > 0) {
        if (!this.discarded) this.readLine(this.buffer)
        this.buffer = ""
        this.discarded = false
      }
      if (this.discarded) continue
      if (this.buffer.length + part.length > RUNTIME_STARTUP_MAX_LINE_LENGTH) {
        this.buffer = ""
        this.discarded = true
      } else this.buffer += part
    }
  }

  private readLine(line: string): void {
    if (!line.startsWith(RUNTIME_STARTUP_PREFIX)) return
    let value: unknown
    try {
      value = JSON.parse(line.slice(RUNTIME_STARTUP_PREFIX.length))
    } catch {
      return
    }
    const parsed = RuntimeStartupProgress.safeParse(value)
    if (!parsed.success || this.failure || this.ready) return
    const next = parsed.data
    if (next.phase === "runtime") {
      this.receiveRuntime(next)
      return
    }
    if (next.phase === "maintenance") {
      this.receiveMaintenance(next)
      return
    }
    if (this.recoveryCompleted) return
    const previous = this.progress
    if (this.runtimeStage) {
      if (next.phase === "storage" && !["storage", "migrations", "storage-recovery"].includes(this.runtimeStage)) return
      if (next.phase === "migration" && this.runtimeStage !== "migrations") return
      if (next.phase === "recovery" && this.runtimeStage !== "execution-recovery") return
      if (next.phase === "starting" && !previous) return
    }
    if (next.phase === "storage") {
      if (previous?.phase === "recovery" || next.step < this.storageStep) return
      if (next.step === this.storageStep) {
        if (previous?.phase !== "storage" || next.stage !== previous.stage) return
        if (next.current < previous.current || next.bytes < previous.bytes) return
        if (
          next.current === previous.current &&
          next.bytes === previous.bytes &&
          !(previous.total === 0 && next.total > 0)
        )
          return
      }
      this.storageStep = next.step
    }
    if (next.phase === "migration" && previous && previous.phase !== "migration" && previous.phase !== "storage") return
    if (next.phase === "starting" && previous?.phase === "starting") return
    if (next.phase === "recovery" && previous?.phase === "recovery" && next.current <= previous.current) return
    if (next.phase === "migration" && previous?.phase === "migration") {
      if (next.step < previous.step) return
      if (next.current < previous.current && next.step === previous.step) return
      if (next.step === previous.step && !(next.current > previous.current || (previous.total === 0 && next.total > 0)))
        return
    }
    const changed =
      next.phase !== previous?.phase ||
      (next.phase === "migration" && previous?.phase === "migration" && next.step !== previous.step) ||
      (next.phase === "storage" && previous?.phase === "storage" && next.step !== previous.step)
    const now = this.now()
    if (changed) this.stepStartedAt = now
    this.lastProgressAt = now
    this.progress = next
    if (next.phase === "starting") {
      if (previous?.phase === "recovery") this.presentationPhase = "starting"
    } else if (next.phase !== "storage" || this.presentationPhase === "storage") this.presentationPhase = next.phase
    this.options.onProgress?.(next)
    if (next.phase === "starting" && previous?.phase === "recovery") this.recoveryCompleted = true
    const complete =
      this.options.mode === "maintenance" &&
      (next.phase === "starting" || (next.phase === "storage" && next.stage === "complete"))
    const timeout =
      next.phase === "storage" && next.stage === "validate-engine" ? next.timeoutMs! : this.migrationIdleMs
    this.deadline = this.now() + (complete ? this.healthTimeoutMs : timeout)
    this.options.onStatus?.(this.status())
  }

  isReady(): boolean {
    return this.ready && !this.failure
  }

  failureError(): Error | undefined {
    return this.failure
  }

  private receiveRuntime(event: RuntimeStartupEvent) {
    if (event.state === "failed") {
      this.failure = new Error(`Synergy runtime startup failed during ${this.runtimeStage ?? "initializing"}`)
      return
    }
    if (event.state === "ready") {
      if (!this.runtimeStage) return
      if (this.maintenance.size) {
        this.failure = new Error("Synergy runtime reported readiness with unfinished database maintenance")
        return
      }
      this.ready = true
      this.presentationPhase = "starting"
    } else {
      const current = event.current ?? 0
      if (event.stage === this.runtimeStage && current <= this.runtimeCurrent) return
      if (
        this.runtimeStage &&
        RuntimeStartupStage.options.indexOf(event.stage) < RuntimeStartupStage.options.indexOf(this.runtimeStage)
      )
        return
      if (event.stage !== this.runtimeStage) this.stepStartedAt = this.now()
      this.runtimeStage = event.stage
      this.runtimeCurrent = current
      this.presentationPhase = ["initializing", "storage"].includes(event.stage)
        ? "storage"
        : ["migrations", "storage-recovery", "configuration"].includes(event.stage)
          ? "migration"
          : event.stage === "execution-recovery"
            ? "recovery"
            : "starting"
    }
    this.progress = undefined
    this.recoveryCompleted = false
    if (this.ready) this.stepStartedAt = this.now()
    this.lastProgressAt = this.now()
    this.deadline = this.lastProgressAt + (this.ready ? this.healthTimeoutMs : this.migrationIdleMs)
    this.options.onStatus?.(this.status())
  }

  remainingMs(): number {
    if (this.failure) return 0
    return (this.currentMaintenance()?.deadline ?? this.deadline) - this.now()
  }

  private currentMaintenance(): Maintenance | undefined {
    let current: Maintenance | undefined
    for (const entry of this.maintenance.values()) if (!current || entry.deadline < current.deadline) current = entry
    return current
  }

  private receiveMaintenance(event: StorageMaintenanceEvent) {
    if (event.state === "started") {
      if (event.id <= this.maintenanceSequence) return
      this.maintenanceSequence = event.id
      if (this.maintenance.size >= 1024) {
        this.failure = new Error("Too many concurrent startup maintenance operations")
        return
      }
      const startedAt = this.now()
      this.maintenance.set(event.id, {
        operation: event.operation,
        startedAt,
        timeoutMs: event.timeoutMs,
        deadline: startedAt + event.timeoutMs + 5000,
      })
    } else {
      const current = this.maintenance.get(event.id)
      if (!current) return
      if (event.state === "stage") {
        if (
          current.stage &&
          StorageMaintenanceStage.options.indexOf(event.stage) <= StorageMaintenanceStage.options.indexOf(current.stage)
        )
          return
        current.stage = event.stage
      } else {
        this.maintenance.delete(event.id)
        if (event.state === "failed")
          this.failure = new Error(
            `Synergy database maintenance ${current.operation} failed after ${event.elapsedMs}ms`,
          )
        this.deadline =
          this.now() +
          (this.options.mode !== "maintenance" ||
          (this.progress &&
            this.progress.phase !== "starting" &&
            !(this.progress.phase === "storage" && this.progress.stage === "complete"))
            ? this.migrationIdleMs
            : this.healthTimeoutMs)
      }
    }
    this.lastProgressAt = this.now()
    this.options.onStatus?.(this.status())
  }

  status(): DesktopStartupStatus {
    const maintenance = this.currentMaintenance()
    const now = this.now()
    const timing = {
      phase: this.presentationPhase,
      elapsedMs: Math.max(0, now - (maintenance?.startedAt ?? this.stepStartedAt)),
      totalElapsedMs: Math.max(0, now - this.startedAt),
      idleMs: Math.max(0, now - this.lastProgressAt),
    }
    if (maintenance)
      return {
        ...timing,
        ...(this.progress?.phase === "migration" && { step: this.progress.step }),
        title: "Updating saved data",
        detail: maintenance.stage ? maintenanceStages[maintenance.stage] : maintenanceLabels[maintenance.operation],
      }
    const progress = this.progress
    if (progress?.phase === "storage" && progress.stage !== "complete") {
      if (progress.stage === "validate-engine")
        return { ...timing, title: "Updating saved data", detail: "Checking database integrity." }
      const labels = {
        prepare: "Preparing storage",
        staging: "Recovering interrupted imports",
        scan: "Scanning saved files",
        backup: "Backing up saved files",
        inventory: "Recording the backup inventory",
        owners: "Checking saved sessions",
        import: "Importing saved records",
        verify: "Verifying the import",
        "archive-verify": "Verifying the saved archive",
        "archive-import": "Importing the saved archive",
        validate: "Verifying saved records",
        activate: "Activating saved records",
        check: "Checking storage ownership",
        artifacts: "Checking saved attachments",
        resources: "Restoring saved resources",
        quarantine: "Loading saved recovery state",
        notifications: "Reconciling saved updates",
      }
      return {
        ...timing,
        title: "Updating saved data",
        detail: labels[progress.stage] + ".",
        progress: { current: progress.current, total: progress.total },
      }
    }
    if (progress?.phase === "recovery")
      return {
        ...timing,
        title: "Restoring saved work",
        detail: "Recovering saved execution history.",
        progress: { current: progress.current, total: 0 },
      }
    if (progress?.phase !== "migration")
      return {
        ...timing,
        title: "Starting Synergy",
        detail: !this.ready && this.runtimeStage ? runtimeLabels[this.runtimeStage] : "Opening your workspace.",
        ...(!this.ready && this.runtimeCurrent > 0 && { progress: { current: this.runtimeCurrent, total: 0 } }),
      }
    return {
      ...timing,
      step: progress.step,
      title: "Updating saved data",
      detail: progress.task ? migrationLabels[progress.task] : "Preparing saved history for this version.",
      progress: { current: progress.current, total: progress.total },
    }
  }

  timeoutError(): Error {
    if (this.failure) return this.failure
    const maintenance = this.currentMaintenance()
    if (maintenance)
      return new Error(
        `Synergy database maintenance ${maintenance.operation}${maintenance.stage ? ` (${maintenance.stage})` : ""} exceeded its ${maintenance.timeoutMs}ms waiting budget after ${Math.floor(this.now() - maintenance.startedAt)}ms`,
      )
    const progress = this.progress
    if (progress?.phase === "storage" && progress.stage === "validate-engine")
      return new Error(`Synergy database integrity check exceeded its ${progress.timeoutMs}ms budget`)
    if (progress?.phase === "storage" && progress.stage !== "complete")
      return new Error(
        `Synergy storage update made no progress for ${this.migrationIdleMs}ms (stage ${progress.stage}, ${progress.current} items checked)`,
      )
    if (progress?.phase === "recovery")
      return new Error(
        `Synergy recovery made no progress for ${this.migrationIdleMs}ms (${progress.current} items checked)`,
      )
    if (progress?.phase !== "migration") {
      if (this.options.mode !== "maintenance" && !this.ready)
        return new Error(
          this.runtimeStage
            ? `Synergy runtime startup made no progress for ${this.migrationIdleMs}ms (stage ${this.runtimeStage}, ${this.runtimeCurrent} items checked)`
            : `Synergy runtime startup did not announce readiness within its waiting budget`,
        )
      return new Error(`Synergy server health check timed out after ${this.healthTimeoutMs}ms`)
    }
    const count = progress.total ? `, ${progress.current}/${progress.total} items` : ""
    return new Error(
      `Synergy data update made no progress for ${this.migrationIdleMs}ms (step ${progress.step}${count})`,
    )
  }
}
