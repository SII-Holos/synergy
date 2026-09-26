import { AsyncLocalStorage } from "node:async_hooks"
import { ObservabilityMetrics } from "../observability/metrics"
import { StorageBusyError, StorageClosedError } from "./errors"

const ADMISSION_DEADLINE_MS = 30_000
export const MAX_PENDING = 1024
const WAIT_SAMPLE_RATE = 0.05
const SLOW_WAIT_MS = 1_000
const SLOW_HOLD_MS = 1_000

interface AdmissionWait {
  waitedMs: number
  parent?: AdmissionWait
}

const admissionWait = new AsyncLocalStorage<AdmissionWait>()

/**
 * Runs `body` with a scope that accumulates the admission wait its own work
 * paid, and hands back a reader for that total.
 *
 * A measured operation subtracts this from its duration, so
 * `storage.queue.wait` and the operation's duration never describe the same
 * interval twice. Each scope owns its total and hands it to its parent on exit,
 * so a measured operation nested in another subtracts exactly the waits its own
 * body paid for and concurrent operations never share one accumulator.
 */
export async function excludingQueueWait<T>(body: (queueWaitMs: () => number) => Promise<T>): Promise<T> {
  const parent = admissionWait.getStore()
  const scope: AdmissionWait = { waitedMs: 0, parent }
  return admissionWait.run(scope, async () => {
    try {
      return await body(() => scope.waitedMs)
    } finally {
      if (parent) parent.waitedMs += scope.waitedMs
    }
  })
}

function recordQueueWait(waitedMs: number) {
  const scope = admissionWait.getStore()
  if (scope) scope.waitedMs += waitedMs
}

export interface StorageQueueOptions {
  deadline?: number
  signal?: AbortSignal
  priority?: "foreground" | "background"
  onWait?(waiting: boolean): void
}

const admission = new AsyncLocalStorage<StorageQueueOptions>()

export function withStorageQueueOptions<T>(options: StorageQueueOptions, body: () => T): T {
  const parent = admission.getStore()
  return admission.run(
    {
      ...parent,
      ...options,
      deadline: Math.min(parent?.deadline ?? Infinity, options.deadline ?? Infinity),
      signal:
        parent?.signal && options.signal
          ? AbortSignal.any([parent.signal, options.signal])
          : (options.signal ?? parent?.signal),
    },
    body,
  )
}

type Waiting = {
  priority: "foreground" | "background"
  execute(): void
  reject(error: unknown): void
}

export class StorageQueue {
  private readonly waiting: Waiting[] = []
  private active = false
  private closed = false
  private drained?: ReturnType<typeof Promise.withResolvers<void>>

  constructor(private readonly name: string) {}

  run<T>(body: () => Promise<T>, options: StorageQueueOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new StorageClosedError())
    if (this.waiting.length + Number(this.active) >= MAX_PENDING)
      return Promise.reject(new StorageBusyError(`Authoritative storage queue is full (${this.name})`))
    const inherited = admission.getStore()
    const onWait = options.onWait ?? inherited?.onWait
    const signal =
      options.signal && inherited?.signal
        ? AbortSignal.any([options.signal, inherited.signal])
        : (options.signal ?? inherited?.signal)
    if (signal?.aborted) return Promise.reject(signal.reason)
    const enqueuedAt = performance.now()
    const deadline = Math.min(
      enqueuedAt + ADMISSION_DEADLINE_MS,
      options.deadline ?? Infinity,
      inherited?.deadline ?? Infinity,
    )
    const priority = options.priority ?? inherited?.priority ?? "foreground"
    const expired = () => new StorageBusyError(`Authoritative storage admission deadline exceeded (${this.name})`)
    if (enqueuedAt >= deadline) return Promise.reject(expired())

    return new Promise<T>((resolve, reject) => {
      const waiting = this.active
      if (waiting) onWait?.(true)
      let timer: ReturnType<typeof setTimeout> | undefined
      const clean = () => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener("abort", cancel)
        if (waiting) onWait?.(false)
      }
      const waited = () => {
        const waitedMs = performance.now() - enqueuedAt
        recordQueueWait(waitedMs)
        ObservabilityMetrics.record({
          name: "storage.queue.wait",
          value: waitedMs,
          unit: "ms",
          module: "storage",
          labels: { queue: this.name, ...(waitedMs >= SLOW_WAIT_MS ? { slow: true } : {}) },
          ...(waitedMs >= SLOW_WAIT_MS ? {} : { sampleRate: WAIT_SAMPLE_RATE }),
        })
      }
      const entry: Waiting = {
        priority,
        // Dispatch may come from another Runtime's completing holder.
        execute: AsyncLocalStorage.bind(() => {
          clean()
          waited()
          if (this.closed || signal?.aborted || performance.now() >= deadline) {
            reject(this.closed ? new StorageClosedError() : signal?.aborted ? signal.reason : expired())
            this.release()
            return
          }
          const startedAt = performance.now()
          void (async () => {
            try {
              resolve(await admission.run({ deadline, signal, priority, onWait }, body))
            } catch (error) {
              reject(error)
            } finally {
              const heldMs = performance.now() - startedAt
              if (heldMs >= SLOW_HOLD_MS)
                ObservabilityMetrics.record({
                  name: "storage.queue.hold",
                  value: heldMs,
                  unit: "ms",
                  module: "storage",
                  labels: { queue: this.name },
                })
              this.release()
            }
          })()
        }),
        reject: AsyncLocalStorage.bind((error: unknown) => {
          const index = this.waiting.indexOf(entry)
          if (index === -1) return
          this.waiting.splice(index, 1)
          clean()
          waited()
          reject(error)
        }),
      }
      const cancel = () => entry.reject(signal?.reason)
      const expire = () => {
        const remaining = deadline - performance.now()
        if (remaining > 0) {
          timer = setTimeout(expire, remaining)
          return
        }
        entry.reject(expired())
      }
      this.waiting.push(entry)
      const depth = this.waiting.length + Number(this.active)
      if (depth > 1)
        ObservabilityMetrics.record({
          name: "storage.queue.depth",
          value: depth,
          unit: "count",
          module: "storage",
          labels: { queue: this.name },
        })
      signal?.addEventListener("abort", cancel, { once: true })
      timer = setTimeout(expire, Math.max(1, deadline - performance.now()))
      this.dispatch()
    })
  }

  private dispatch() {
    if (this.active || this.closed) return
    const foreground = this.waiting.findIndex((entry) => entry.priority === "foreground")
    const [next] = this.waiting.splice(Math.max(0, foreground), 1)
    if (!next) return
    this.active = true
    next.execute()
  }

  private release() {
    this.active = false
    this.dispatch()
    if (!this.active && !this.waiting.length) this.drained?.resolve()
  }

  close(): Promise<void> {
    this.closed = true
    for (const entry of [...this.waiting]) entry.reject(new StorageClosedError())
    if (!this.active) return Promise.resolve()
    this.drained ??= Promise.withResolvers<void>()
    return this.drained.promise
  }
}
