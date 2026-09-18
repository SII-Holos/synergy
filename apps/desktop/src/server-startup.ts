import {
  RUNTIME_STARTUP_MAX_LINE_LENGTH,
  RUNTIME_STARTUP_PREFIX,
  RuntimeStartupProgress,
} from "@ericsanchezok/synergy-util/runtime-startup"
import type { DesktopStartupStatus } from "./startup-page.js"

export class DesktopServerStartup {
  private buffer = ""
  private discarded = false
  private progress: RuntimeStartupProgress | undefined
  private recoveryCompleted = false
  private storageStep = 0
  private deadline: number
  private readonly now: () => number
  private readonly healthTimeoutMs: number
  private readonly migrationIdleMs: number

  constructor(
    private readonly options: {
      now?: () => number
      healthTimeoutMs?: number
      migrationIdleMs?: number
      onStatus?: (status: DesktopStartupStatus) => void
    } = {},
  ) {
    this.now = options.now ?? Date.now
    this.healthTimeoutMs = options.healthTimeoutMs ?? 30_000
    this.migrationIdleMs = options.migrationIdleMs ?? 5 * 60_000
    this.deadline = this.now() + this.healthTimeoutMs
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
    if (!parsed.success || this.recoveryCompleted) return
    const next = parsed.data
    const previous = this.progress
    if (next.phase === "storage") {
      if (previous?.phase === "recovery" || next.step < this.storageStep) return
      if (next.step === this.storageStep) {
        if (previous?.phase !== "storage" || next.stage !== previous.stage) return
        if (next.current <= previous.current && next.bytes <= previous.bytes) return
      }
      this.storageStep = next.step
    }
    if (next.phase === "migration" && previous && previous.phase !== "migration" && previous.phase !== "storage") return
    if (next.phase === "starting" && previous?.phase === "starting") return
    if (next.phase === "recovery" && previous?.phase === "recovery" && next.current <= previous.current) return
    if (next.phase === "migration" && previous?.phase === "migration") {
      if (next.step < previous.step) return
      if (next.step === previous.step && !(next.current > previous.current || (previous.total === 0 && next.total > 0)))
        return
    }
    this.progress = next
    if (next.phase === "starting" && previous?.phase === "recovery") this.recoveryCompleted = true
    const complete = next.phase === "starting" || (next.phase === "storage" && next.stage === "complete")
    const timeout =
      next.phase === "storage" && next.stage === "validate-engine" ? next.timeoutMs! : this.migrationIdleMs
    this.deadline = this.now() + (complete ? this.healthTimeoutMs : timeout)
    this.options.onStatus?.(this.status())
  }

  remainingMs(): number {
    return this.deadline - this.now()
  }

  status(): DesktopStartupStatus {
    const progress = this.progress
    if (progress?.phase === "storage" && progress.stage !== "complete") {
      if (progress.stage === "validate-engine")
        return { title: "Updating saved data", detail: "Checking database integrity." }
      const labels = {
        prepare: "Preparing storage",
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
      }
      return {
        title: "Updating saved data",
        detail: labels[progress.stage] + ". " + progress.current + " items checked.",
        progress: progress.total > 0 ? { current: progress.current, total: progress.total } : undefined,
      }
    }
    if (progress?.phase === "recovery")
      return {
        title: "Restoring saved work",
        detail: `${progress.current} items checked. Your execution history is being recovered.`,
      }
    if (progress?.phase !== "migration")
      return {
        title: "Starting Synergy",
        detail: "Opening your workspace.",
      }
    return {
      title: "Updating saved data",
      detail: `Step ${progress.step}. Your history is being prepared for this version.`,
      progress: progress.total > 0 ? { current: progress.current, total: progress.total } : undefined,
    }
  }

  timeoutError(): Error {
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
    if (progress?.phase !== "migration")
      return new Error(`Synergy server health check timed out after ${this.healthTimeoutMs}ms`)
    const count = progress.total ? `, ${progress.current}/${progress.total} items` : ""
    return new Error(
      `Synergy data update made no progress for ${this.migrationIdleMs}ms (step ${progress.step}${count})`,
    )
  }
}
