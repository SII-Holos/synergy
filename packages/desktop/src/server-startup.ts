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
    if (!parsed.success || this.progress?.phase === "starting") return
    const next = parsed.data
    const previous = this.progress
    if (next.phase === "migration" && previous?.phase === "migration") {
      if (next.step < previous.step) return
      if (next.step === previous.step && !(next.current > previous.current || (previous.total === 0 && next.total > 0)))
        return
    }
    this.progress = next
    this.deadline = this.now() + (next.phase === "migration" ? this.migrationIdleMs : this.healthTimeoutMs)
    this.options.onStatus?.(this.status())
  }

  remainingMs(): number {
    return this.deadline - this.now()
  }

  status(): DesktopStartupStatus {
    const progress = this.progress
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
    if (progress?.phase !== "migration")
      return new Error(`Synergy server health check timed out after ${this.healthTimeoutMs}ms`)
    const count = progress.total ? `, ${progress.current}/${progress.total} items` : ""
    return new Error(
      `Synergy data update made no progress for ${this.migrationIdleMs}ms (step ${progress.step}${count})`,
    )
  }
}
