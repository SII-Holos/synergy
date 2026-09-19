import { ObservabilityMetrics } from "../observability/metrics"
import { StorageBusyError, StorageClosedError } from "./errors"

const ADMISSION_DEADLINE_MS = 30_000
export const MAX_PENDING = 1024
const WAIT_SAMPLE_RATE = 0.05
const SLOW_WAIT_MS = 1_000
const SLOW_HOLD_MS = 1_000

/**
 * Serializes work on one underlying resource.
 *
 * The queue names itself in every rejection and reports its own wait, depth and
 * hold because several instances share the same wording. Without an identity a
 * storage stall cannot be attributed to the queue that produced it, and without
 * these metrics neither the wait that reached the deadline nor the caller that
 * caused it leaves any trace.
 */
export class StorageQueue {
  private tail = Promise.resolve()
  private pending = 0
  private closed = false

  constructor(private readonly name: string) {}

  async run<T>(body: () => Promise<T>): Promise<T> {
    if (this.closed) throw new StorageClosedError()
    if (this.pending >= MAX_PENDING) throw new StorageBusyError(`Authoritative storage queue is full (${this.name})`)
    this.pending++
    // Depth is recorded once contention exists; a depth of one is every
    // uncontended request and would dominate the series without describing a
    // queue. Actual queueing is exactly what the caller of this branch sees.
    if (this.pending > 1)
      ObservabilityMetrics.record({
        name: "storage.queue.depth",
        value: this.pending,
        unit: "count",
        module: "storage",
        labels: { queue: this.name },
      })
    // A suspended host advances the wall clock without letting the queue make
    // progress, so the wait budget is measured monotonically. `setTimeout`
    // still does the scheduling; only the decision is monotonic.
    const enqueuedAt = performance.now()
    const deadline = enqueuedAt + ADMISSION_DEADLINE_MS
    const previous = this.tail
    const next = Promise.withResolvers<void>()
    this.tail = next.promise
    try {
      await previous
      const waitedMs = performance.now() - enqueuedAt
      // A wait that reaches the deadline is the event that rejects a caller, so
      // it is never left to sampling; ordinary waits are sampled to keep the
      // series cheap on a hot path.
      if (waitedMs >= SLOW_WAIT_MS)
        ObservabilityMetrics.record({
          name: "storage.queue.wait",
          value: waitedMs,
          unit: "ms",
          module: "storage",
          labels: { queue: this.name, slow: true },
        })
      else
        ObservabilityMetrics.record({
          name: "storage.queue.wait",
          value: waitedMs,
          unit: "ms",
          module: "storage",
          labels: { queue: this.name },
          sampleRate: WAIT_SAMPLE_RATE,
        })
      if (performance.now() > deadline)
        throw new StorageBusyError(`Authoritative storage admission deadline exceeded (${this.name})`)
      // The holder was invisible by construction before this: the wait budget is
      // checked once before the body runs, so a long-holding caller was never
      // measured and a stalled queue could not name what was holding it.
      const startedAt = performance.now()
      try {
        return await body()
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
      }
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
