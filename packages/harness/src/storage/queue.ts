import { StorageBusyError, StorageClosedError } from "./errors"

export class StorageQueue {
  private tail = Promise.resolve()
  private pending = 0
  private closed = false

  async run<T>(body: () => Promise<T>): Promise<T> {
    if (this.closed) throw new StorageClosedError()
    if (this.pending >= 1024) throw new StorageBusyError("Authoritative storage queue is full")
    this.pending++
    const deadline = Date.now() + 30_000
    const previous = this.tail
    const next = Promise.withResolvers<void>()
    this.tail = next.promise
    try {
      await previous
      if (Date.now() > deadline) throw new StorageBusyError("Authoritative storage admission deadline exceeded")
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
