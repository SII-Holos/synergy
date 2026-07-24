import { ProcessInspection } from "../process/inspection.js"

// ── Concurrency limiter ───────────────────────────────────────────

export class ConcurrencyLimiter {
  private active = 0

  constructor(private max: number) {}

  acquire(): boolean {
    if (this.active >= this.max) return false
    this.active++
    return true
  }

  release(): void {
    if (this.active > 0) this.active--
  }

  activeCount(): number {
    return this.active
  }
}

/**
 * Get the RSS memory (in MB) for a process.
 *
 * On Linux: reads /proc/{pid}/status for VmRSS (in kB), converts to MB.
 * On macOS: shells out to `ps -o rss=` (in kB), converts to MB.
 * Falls back to 0 on any error.
 */
export async function getProcessMemoryMb(pid: number): Promise<number> {
  return Math.round((ProcessInspection.rssBytes(pid) ?? 0) / (1024 * 1024))
}

export interface MemoryMonitorInput {
  pluginId: string
  pid: number
  maxMb: number
  intervalMs: number
  onSample(currentMb: number): void
  onExceed(currentMb: number, maxMb: number): void
}

export type MemoryMonitor = { stop(): void }

export function startMemoryMonitor(input: MemoryMonitorInput): MemoryMonitor {
  let stopped = false

  const timer = setInterval(async () => {
    if (stopped) return
    try {
      const currentMb = await getProcessMemoryMb(input.pid)
      if (currentMb <= 0) return
      input.onSample(currentMb)
      if (currentMb > input.maxMb) {
        input.onExceed(currentMb, input.maxMb)
      }
    } catch {
      // Polling failure is non-fatal — skip this tick
    }
  }, input.intervalMs)
  timer.unref()

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}

// ── Log rate limiter ──────────────────────────────────────────────

export class LogRateLimiter {
  private totalBytes = 0
  private windowStart = 0

  constructor(private maxBytesPerMinute: number) {}

  allow(bytes: number): boolean {
    const now = Date.now()
    if (now - this.windowStart >= 60_000) {
      this.totalBytes = 0
      this.windowStart = now
    }
    if (this.totalBytes + bytes > this.maxBytesPerMinute) return false
    this.totalBytes += bytes
    return true
  }

  reset(): void {
    this.totalBytes = 0
    this.windowStart = 0
  }
}
