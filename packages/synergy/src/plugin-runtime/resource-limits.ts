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
  const platform = process.platform
  try {
    if (platform === "linux") {
      const file = Bun.file(`/proc/${pid}/status`)
      const text = await file.text()
      const match = text.match(/^VmRSS:\s+(\d+)\s+kB$/m)
      if (match) {
        return Math.round(Number(match[1]) / 1024)
      }
      return 0
    }
    if (platform === "darwin") {
      const result = Bun.spawnSync({
        cmd: ["ps", "-o", "rss=", "-p", String(pid)],
        stdout: "pipe",
      })
      const rssKb = Number(result.stdout.toString().trim())
      if (Number.isFinite(rssKb) && rssKb > 0) {
        return Math.round(rssKb / 1024)
      }
      return 0
    }
    return 0
  } catch {
    return 0
  }
}

export function startMemoryMonitor(
  pluginId: string,
  pid: number,
  maxMb: number,
  intervalMs: number,
  onExceed: (pluginId: string, currentMb: number, maxMb: number) => void,
): { stop: () => void } {
  let stopped = false

  const timer = setInterval(async () => {
    if (stopped) return
    try {
      const currentMb = await getProcessMemoryMb(pid)
      if (currentMb > maxMb) {
        onExceed(pluginId, currentMb, maxMb)
      }
    } catch {
      // Polling failure is non-fatal — skip this tick
    }
  }, intervalMs)

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
