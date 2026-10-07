import { ProcessInspection } from "@ericsanchezok/synergy-harness/process/inspection"

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

export async function getProcessMemoryMb(pid: number, signal?: AbortSignal): Promise<number | undefined> {
  const rssBytes = await ProcessInspection.rssBytes(pid, { signal })
  return rssBytes === undefined ? undefined : Math.round(rssBytes / (1024 * 1024))
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
  let pending: AbortController | undefined

  const timer = setInterval(async () => {
    if (stopped || pending) return
    const controller = new AbortController()
    pending = controller
    try {
      const currentMb = await getProcessMemoryMb(input.pid, controller.signal)
      if (stopped || currentMb === undefined || currentMb <= 0) return
      input.onSample(currentMb)
      if (currentMb > input.maxMb) {
        input.onExceed(currentMb, input.maxMb)
      }
    } catch {
      // Polling failure is non-fatal — skip this tick
    } finally {
      pending = undefined
    }
  }, input.intervalMs)
  timer.unref()

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
      pending?.abort()
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
