import { StorageBusyError } from "../storage/errors"
type Entry<T, P> = { path: P; value: T; bytes: number }

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

  defer(key: string, path: P, value: T): void {
    const failure = this.failures.get(key)
    if (failure) throw failure.error
    const bytes = Buffer.byteLength(JSON.stringify(value))
    const previous = this.latest.get(key)?.bytes ?? 0
    if ((!this.latest.has(key) && this.latest.size >= 1024) || this.bytes - previous + bytes > 64 * 1024 * 1024)
      throw new StorageBusyError("Streaming persistence buffer is full; drain before accepting more output")
    this.latest.set(key, { path, value: structuredClone(value), bytes })
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
    if (entry) return this.execute(key, entry)
    return this.running.get(key)?.promise ?? Promise.resolve()
  }

  private execute(key: string, entry: Entry<T, P>, write = this.write): Promise<void> {
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
    const failure = this.failures.get(key)
    if (failure) throw failure.error
    await this.execute(
      key,
      { path, value: structuredClone(value), bytes: Buffer.byteLength(JSON.stringify(value)) },
      write,
    )
  }

  flushAll(): Promise<void> {
    return this.flushWhere(() => true)
  }

  async flushWhere(predicate: (value: T, path: P) => boolean): Promise<void> {
    const keys = new Set<string>()
    for (const [key, entry] of this.latest) if (predicate(entry.value, entry.path)) keys.add(key)
    for (const [key, { entry }] of this.running) if (predicate(entry.value, entry.path)) keys.add(key)
    const results = await Promise.allSettled([...keys].map((key) => this.flush(key)))
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    for (const { entry, error } of this.failures.values())
      if (predicate(entry.value, entry.path) && !errors.includes(error)) errors.push(error)
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
