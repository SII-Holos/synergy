export class BrowserStagingLeasePool {
  private entries: Array<{ cleanup: () => Promise<void> | void; timer: ReturnType<typeof setTimeout> }> = []
  private pending = new Set<Promise<void>>()
  private failures: unknown[] = []

  constructor(
    private maxLeases = 5,
    private ttlMs = 10 * 60_000,
  ) {}

  retain(cleanup: (() => Promise<void> | void) | undefined): void {
    if (!cleanup) return
    const entry = { cleanup, timer: setTimeout(() => this.release(cleanup), this.ttlMs) }
    entry.timer.unref?.()
    this.entries.push(entry)
    while (this.entries.length > this.maxLeases) this.releaseEntry(this.entries[0]!)
  }

  async dispose(): Promise<void> {
    for (const entry of this.entries.splice(0)) {
      clearTimeout(entry.timer)
      this.runCleanup(entry.cleanup)
    }
    await Promise.allSettled(Array.from(this.pending))
    const failures = this.failures.splice(0)
    if (failures.length) throw new AggregateError(failures, "Browser staging files could not be fully removed.")
  }

  private release(cleanup: () => Promise<void> | void): void {
    const entry = this.entries.find((candidate) => candidate.cleanup === cleanup)
    if (entry) this.releaseEntry(entry)
  }

  private releaseEntry(entry: (typeof this.entries)[number]): void {
    const index = this.entries.indexOf(entry)
    if (index < 0) return
    this.entries.splice(index, 1)
    clearTimeout(entry.timer)
    this.runCleanup(entry.cleanup)
  }

  private runCleanup(cleanup: () => Promise<void> | void): void {
    const task = Promise.resolve()
      .then(cleanup)
      .catch((error) => {
        this.failures.push(error)
      })
      .finally(() => this.pending.delete(task))
    this.pending.add(task)
  }
}
