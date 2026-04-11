import { Log } from "../../../util/log"

const log = Log.create({ service: "channel.feishu.debounce" })

export type InboundDebouncerConfig<T> = {
  debounceMs: number
  buildKey: (event: T) => string | null
  resolveText: (event: T) => string
  onFlush: (merged: { events: T[]; combinedText: string; last: T }) => Promise<void>
  onError?: (err: unknown) => void
}

export class InboundDebouncer<T> {
  private pending = new Map<string, { events: T[]; timer: ReturnType<typeof setTimeout> }>()
  private config: InboundDebouncerConfig<T>

  constructor(config: InboundDebouncerConfig<T>) {
    this.config = config
  }

  enqueue(event: T): void {
    const key = this.config.buildKey(event)

    if (key === null || this.config.debounceMs <= 0) {
      const text = this.config.resolveText(event)
      this.config.onFlush({ events: [event], combinedText: text, last: event }).catch((err) => {
        this.handleError(err)
      })
      return
    }

    const existing = this.pending.get(key)
    if (existing) {
      existing.events.push(event)
      clearTimeout(existing.timer)
      existing.timer = setTimeout(() => this.flushKey(key), this.config.debounceMs)
      log.debug("debounce extended", { key, count: existing.events.length })
    } else {
      const timer = setTimeout(() => this.flushKey(key), this.config.debounceMs)
      this.pending.set(key, { events: [event], timer })
      log.debug("debounce started", { key })
    }
  }

  async flush(): Promise<void> {
    const keys = Array.from(this.pending.keys())
    await Promise.all(keys.map((key) => this.flushKey(key)))
  }

  private flushKey(key: string): Promise<void> {
    const entry = this.pending.get(key)
    if (!entry) return Promise.resolve()

    clearTimeout(entry.timer)
    this.pending.delete(key)

    const combinedText = entry.events.map((event) => this.config.resolveText(event)).join("\n")
    const last = entry.events[entry.events.length - 1]

    log.debug("debounce flushed", { key, count: entry.events.length })

    return this.config.onFlush({ events: entry.events, combinedText, last }).catch((err) => {
      this.handleError(err)
    })
  }

  private handleError(err: unknown): void {
    if (this.config.onError) {
      this.config.onError(err)
    } else {
      log.error("debounce flush failed", { error: err })
    }
  }
}
