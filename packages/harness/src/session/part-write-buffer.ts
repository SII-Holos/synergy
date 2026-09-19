import { StorageBusyError } from "../storage/errors"
type Entry<T, P> = { path: P; value: T; bytes: number }

/**
 * Serialized growth of appending `chunk` to a JSON string field: the escaped
 * body is what the enclosing string gained, minus the two quotes
 * `JSON.stringify` wraps around the chunk itself.
 */
function measureAppendedBytes(chunk: string): number {
  return Buffer.byteLength(JSON.stringify(chunk)) - 2
}

export class PartWriteBuffer<T, P = string> {
  private bytes = 0
  private readonly latest = new Map<string, Entry<T, P>>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly running = new Map<string, { entry: Entry<T, P>; promise: Promise<void> }>()
  private readonly failures = new Map<string, { entry: Entry<T, P>; error: unknown }>()

  constructor(
    private readonly write: (path: P, value: T) => void | Promise<void>,
    private readonly intervalMs = 500,
  ) {}

  /**
   * Buffers the latest state of a streaming value. `appended` is the text the
   * caller appended to `value` since the previous defer for this key, which is
   * what lets repeated deltas cost O(delta): the buffer holds a reference to
   * the caller's object instead of re-serializing and cloning the accumulated
   * value per delta. Omit `appended`, or hand over a different object for the
   * same key, and the value is measured once instead. Flushing snapshots
   * whatever the buffered value holds at that moment.
   */
  defer(key: string, path: P, value: T, appended?: string): void {
    const failure = this.failures.get(key)
    if (failure) throw failure.error
    const buffered = this.latest.get(key)
    const previous = buffered?.bytes ?? 0
    const bytes =
      appended !== undefined && buffered?.value === value
        ? previous + measureAppendedBytes(appended)
        : Buffer.byteLength(JSON.stringify(value))
    if ((!buffered && this.latest.size >= 1024) || this.bytes - previous + bytes > 64 * 1024 * 1024)
      throw new StorageBusyError("Streaming persistence buffer is full; drain before accepting more output")
    this.latest.set(key, { path, value, bytes })
    this.bytes += bytes - previous
    if (!this.timers.has(key))
      this.timers.set(
        key,
        setTimeout(() => {
          void this.flush(key).catch(() => {})
        }, this.intervalMs),
      )
  }

  flush(key: string): Promise<void> {
    const entry = this.latest.get(key)
    this.cancel(key)
    if (entry) return this.execute(key, entry.path, entry.value)
    return this.running.get(key)?.promise ?? Promise.resolve()
  }

  private execute(key: string, path: P, value: T, write = this.write): Promise<void> {
    let snapshot: T
    try {
      snapshot = structuredClone(value)
    } catch (error) {
      return Promise.reject(error)
    }
    // The caller keeps mutating the streaming object while a write is in
    // flight; the snapshot is what makes the persisted state the flush-time
    // state and keeps later mutations out of the write.
    const entry: Entry<T, P> = { path, value: snapshot, bytes: Buffer.byteLength(JSON.stringify(snapshot)) }
    if (this.bytes + entry.bytes > 64 * 1024 * 1024)
      return Promise.reject(new StorageBusyError("Streaming persistence buffer is full"))
    this.bytes += entry.bytes
    const previous = this.running.get(key)?.promise
    let writing: Promise<void>
    try {
      writing = previous
        ? previous.then(() => write(entry.path, entry.value))
        : Promise.resolve(write(entry.path, entry.value))
    } catch (error) {
      writing = Promise.reject(error)
    }
    const promise = writing.then(
      () => {
        this.bytes -= entry.bytes
        this.failures.delete(key)
        if (this.running.get(key)?.promise === promise) this.running.delete(key)
      },
      (error: unknown) => {
        this.bytes -= entry.bytes
        this.failures.set(key, { entry, error })
        if (this.running.get(key)?.promise === promise) this.running.delete(key)
        throw error
      },
    )
    this.running.set(key, { entry, promise })
    // Timed writes have no awaiting caller; retain their errors for every drain boundary.
    void promise.catch(() => {})
    return promise
  }

  async writeNow(key: string, path: P, value: T, write = this.write): Promise<void> {
    this.cancel(key)
    await this.execute(key, path, value, write)
  }

  flushAll(): Promise<void> {
    return this.flushWhere(() => true)
  }

  assertDrained(key: string): void {
    if (this.latest.has(key) || this.running.has(key) || this.failures.has(key))
      throw new StorageBusyError("Drain streaming part writes before entering a business transaction")
  }

  async flushWhere(predicate: (value: T, path: P) => boolean): Promise<void> {
    const keys = new Set<string>()
    for (const [key, entry] of this.latest) if (predicate(entry.value, entry.path)) keys.add(key)
    for (const [key, { entry }] of this.running) if (predicate(entry.value, entry.path)) keys.add(key)
    // Retained failures retry at every drain boundary instead of poisoning
    // later turns: one transient storage error must not wedge a session
    // until the Runtime restarts. Keys with a newer buffered or running
    // entry flush that entry instead, and its success clears the failure.
    const retries = [...this.failures.entries()]
      .filter(([key, { entry }]) => predicate(entry.value, entry.path) && !keys.has(key))
      .map(([key, { entry }]) => this.execute(key, entry.path, entry.value))
    const results = await Promise.allSettled([...keys].map((key) => this.flush(key)).concat(retries))
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, "Part persistence failed")
  }

  cancel(key: string): void {
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
    this.bytes -= this.latest.get(key)?.bytes ?? 0
    this.latest.delete(key)
  }
}
