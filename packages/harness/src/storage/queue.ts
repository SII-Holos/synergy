import { StorageBusyError, StorageClosedError } from "./errors"

export class StorageQueue {
  private tail = Promise.resolve()
  private pending = 0
  private closed = false

  async run<T>(body: () => Promise<T>): Promise<T> {
    if (this.closed) throw new StorageClosedError()
    if (this.pending >= 1024) throw new StorageBusyError("Authoritative storage queue is full")
    this.pending++
    // A suspended host advances the wall clock without letting the queue make
    // progress, so the wait budget is measured monotonically. `setTimeout`
    // still does the scheduling; only the decision is monotonic.
    const deadline = performance.now() + 30_000
    const previous = this.tail
    const next = Promise.withResolvers<void>()
    this.tail = next.promise
    try {
      await previous
      if (performance.now() > deadline) throw new StorageBusyError("Authoritative storage admission deadline exceeded")
      return await body()
    } finally {
      this.pending--
      next.resolve()
    }
  }

  async close() {
    this.closed = true
    await this.tail
  }
}
