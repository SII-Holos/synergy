type Options = {
  write?: (line: string) => void
  now?: () => number
  schedule?: (tick: () => void) => () => void
}

type Phase = {
  label: string
  startedAt: number
  reportedAt: number
  reportedBytes: number
  bytes?: number
  total?: number
}

const interval = 5_000
const mebibyte = 1024 * 1024

function duration(milliseconds: number) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export class ComputerBuildProgress {
  private readonly write: (line: string) => void
  private readonly now: () => number
  private readonly schedule: (tick: () => void) => () => void
  private readonly startedAt: number
  private phase?: Phase

  constructor(options: Options = {}) {
    this.write = options.write ?? ((line) => process.stderr.write(line))
    this.now = options.now ?? (() => performance.now())
    this.schedule =
      options.schedule ??
      ((tick) => {
        const timer = setInterval(tick, interval)
        timer.unref()
        return () => clearInterval(timer)
      })
    this.startedAt = this.now()
  }

  log(message: string) {
    this.write(`[computer] ${message}\n`)
  }

  download(bytes: number, total?: number) {
    if (!this.phase) return
    this.phase.bytes = bytes
    this.phase.total = total
  }

  private report(phase: Phase, outcome = "") {
    const now = this.now()
    const fields = [phase.label + outcome]
    if (phase.bytes !== undefined) {
      const received = (phase.bytes / mebibyte).toFixed(1)
      const total = phase.total
      if (total !== undefined && Number.isSafeInteger(total) && total > 0 && phase.bytes <= total) {
        fields.push(`${received} / ${(total / mebibyte).toFixed(1)} MiB`)
        fields.push(`${Math.floor((phase.bytes / total) * 100)}%`)
      } else fields.push(`${received} MiB`)
      const seconds = (now - phase.reportedAt) / 1000
      const speed = seconds > 0 ? (phase.bytes - phase.reportedBytes) / seconds / mebibyte : 0
      fields.push(`${Math.max(0, speed).toFixed(1)} MiB/s`)
      phase.reportedBytes = phase.bytes
    }
    fields.push(`elapsed ${duration(now - phase.startedAt)}`)
    this.log(fields.join(" · "))
    phase.reportedAt = now
  }

  async step<T>(label: string, work: () => Promise<T>): Promise<T> {
    const now = this.now()
    const phase: Phase = { label, startedAt: now, reportedAt: now, reportedBytes: 0 }
    this.phase = phase
    this.report(phase)
    const stop = this.schedule(() => {
      if (this.phase === phase && this.now() - phase.reportedAt >= interval) this.report(phase)
    })
    try {
      const result = await work()
      this.report(phase, " complete")
      return result
    } catch (error) {
      this.log(
        `${label} failed · elapsed ${duration(this.now() - phase.startedAt)} · ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    } finally {
      stop()
      this.phase = undefined
    }
  }

  ready(message = "Driver ready") {
    this.log(`${message} · total ${duration(this.now() - this.startedAt)}`)
  }
}
