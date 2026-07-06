// Write-behind buffer for streaming part persistence (frontend sync redesign,
// perf hotspot S1). updatePart used to write the full part to disk on every
// text/reasoning delta — O(part²) disk I/O for a long streamed reply. Streaming
// increments are now coalesced through this buffer (at most one write per
// interval per part), while discrete/terminal updates (tool state changes, the
// final no-delta part write) go straight to disk so persistence is never lost
// at a meaningful boundary.

export class PartWriteBuffer<T, P = string> {
  private latest = new Map<string, { path: P; value: T }>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly write: (path: P, value: T) => void,
    private readonly intervalMs = 500,
  ) {}

  /** Coalesce a streaming increment: remember the latest value, flush on a timer. */
  defer(key: string, path: P, value: T): void {
    this.latest.set(key, { path, value })
    if (!this.timers.has(key)) {
      this.timers.set(
        key,
        setTimeout(() => this.flush(key), this.intervalMs),
      )
    }
  }

  /** Flush the buffered value for a key now (used by the timer and on shutdown). */
  flush(key: string): void {
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
    const entry = this.latest.get(key)
    this.latest.delete(key)
    if (entry) this.write(entry.path, entry.value)
  }

  /** Flush every pending write (e.g. on session idle / shutdown). */
  flushAll(): void {
    for (const key of [...this.latest.keys()]) this.flush(key)
  }

  /** Drop any pending deferred write for a key without persisting it. Used when
   *  the caller is about to persist a superseding value itself. */
  cancel(key: string): void {
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
    this.latest.delete(key)
  }
}
