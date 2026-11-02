import type { ResourceSnapshot, ResourceStatus } from "./schema"

export interface MemoryRequest {
  owner: string
  bytes: number
  minimumBytes?: number
  pool?: string
  signal?: AbortSignal
}

export interface MemoryLease {
  checkpoint(remainingBytes: number): void
  release(): void
}

interface Commitment {
  bytes: number
  pool?: string
  checkpoint?: { bytes: number; revision: number }
}

interface Waiter {
  request: MemoryRequest
  queuedAt: number
  resolve(lease: MemoryLease): void
  reject(error: unknown): void
  removeAbort(): void
}

/** One ledger for future allocation, independent of task and worker lifecycle. */
export class MemoryAdmission {
  private snapshot?: ResourceSnapshot
  private revision = 0
  private mode: ResourceStatus["state"] = "normal"
  private healthySince?: number
  private healthySamples = 0
  private probeRevision = -1
  private completedProbes = 0
  private lastOwner?: string
  private readonly commitments = new Set<Commitment>()
  private readonly waiters: Waiter[] = []
  private readonly limits = new Map<string, number>()
  private closed = false
  private draining = false
  private volatilityBytes = 0
  private readonly now: () => number
  private readonly reserve: number

  constructor(private readonly options: { reserveBytes?: number; now?: () => number; changed?: () => void } = {}) {
    this.now = options.now ?? Date.now
    // Cold control-plane allowance; observed allocation volatility can only raise it.
    this.reserve = options.reserveBytes ?? 128 * 1024 ** 2
  }

  setLimit(pool: string, limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Resource pool ceiling must be positive")
    this.limits.set(pool, limit)
    this.drain()
  }

  update(snapshot: ResourceSnapshot) {
    if (this.closed) return
    if (this.snapshot && snapshot.sampledAt < this.snapshot.sampledAt) return
    const previous = this.snapshot
    this.snapshot = snapshot
    this.revision++
    if (previous) {
      const drop = Math.max(0, this.available(previous) - this.available(snapshot))
      this.volatilityBytes = Math.max(this.volatilityBytes * 0.8, Math.min(drop, this.reserve * 8))
    }
    for (const lease of this.commitments) {
      if (!lease.checkpoint || lease.checkpoint.revision >= this.revision) continue
      lease.bytes = lease.checkpoint.bytes
      lease.checkpoint = undefined
    }
    if (snapshot.pressure !== "normal" || !this.usable()) {
      this.mode = snapshot.pressure === "warning" && this.usable() ? "constrained" : "blocked"
      this.healthySince = undefined
      this.healthySamples = 0
      this.completedProbes = 0
    } else if (this.mode !== "normal") {
      this.healthySince ??= this.now()
      if (this.now() - this.healthySince >= 10_000) {
        this.mode = "recovering"
        this.healthySamples++
        if (this.healthySamples >= 5 && this.completedProbes > 0) this.mode = "normal"
      }
    }
    this.drain()
    this.options.changed?.()
  }

  acquire(request: MemoryRequest): Promise<MemoryLease> {
    if (this.closed) return Promise.reject(new Error("Memory admission is closed"))
    if (
      !Number.isFinite(request.bytes) ||
      request.bytes < 0 ||
      (request.minimumBytes !== undefined &&
        (!Number.isFinite(request.minimumBytes) || request.minimumBytes < 0 || request.minimumBytes > request.bytes))
    )
      return Promise.reject(new Error("Invalid memory admission request"))
    if (request.signal?.aborted) return Promise.reject(request.signal.reason)
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.waiters.indexOf(waiter)
        if (index < 0) return
        this.waiters.splice(index, 1)
        waiter.removeAbort()
        reject(request.signal?.reason)
        this.drain()
        this.options.changed?.()
      }
      const waiter: Waiter = {
        request,
        queuedAt: this.now(),
        resolve,
        reject,
        removeAbort: () => request.signal?.removeEventListener("abort", abort),
      }
      request.signal?.addEventListener("abort", abort, { once: true })
      this.waiters.push(waiter)
      this.drain()
      this.options.changed?.()
    })
  }

  status(): ResourceStatus {
    const reservedBytes = [...this.commitments].reduce((sum, lease) => sum + lease.bytes, 0)
    const reserveBytes = this.reserve + this.volatilityBytes
    const headroomBytes = Math.max(0, this.available(this.snapshot) - reserveBytes - reservedBytes)
    const reason: ResourceStatus["reason"] = this.closed
      ? "closed"
      : !this.usable()
        ? "unavailable_sample"
        : this.stale()
          ? "stale_sample"
          : this.snapshot?.pressure === "critical"
            ? "critical_pressure"
            : this.mode === "blocked" || this.mode === "recovering"
              ? "recovering"
              : this.mode === "constrained"
                ? "memory_pressure"
                : this.waiters.some((item) => item.request.bytes > headroomBytes)
                  ? "headroom"
                  : "available"
    return {
      revision: this.revision,
      snapshot: this.snapshot ?? null,
      state: ["closed", "unavailable_sample", "stale_sample"].includes(reason) ? "blocked" : this.mode,
      reason,
      reserveBytes,
      reservedBytes,
      headroomBytes,
      active: this.commitments.size,
      queued: this.waiters.length,
      nextReviewAt: (this.snapshot?.sampledAt ?? this.now()) + this.intervalMs(),
    }
  }

  intervalMs() {
    return this.waiters.length || this.mode !== "normal" ? 1000 : 5000
  }

  close() {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.removeAbort()
      waiter.reject(new Error("Memory admission is closed"))
    }
    this.options.changed?.()
  }

  private available(snapshot?: ResourceSnapshot) {
    return snapshot?.domains.length ? Math.min(...snapshot.domains.map((domain) => domain.availableBytes)) : 0
  }

  private usable() {
    return (
      !!this.snapshot &&
      this.snapshot.quality !== "unavailable" &&
      this.snapshot.domains.some((domain) => domain.kind === "physical")
    )
  }

  private stale() {
    return this.now() - (this.snapshot?.sampledAt ?? 0) > 3 * this.intervalMs()
  }

  private drain() {
    if (this.draining || this.closed) return
    this.draining = true
    try {
      for (;;) {
        const status = this.status()
        if (status.state === "blocked") break
        if (status.state !== "normal" && this.probeRevision === this.revision) break
        const owners = [...new Set(this.waiters.map((waiter) => waiter.request.owner))]
        const previous = owners.indexOf(this.lastOwner ?? "")
        const ordered = previous < 0 ? owners : [...owners.slice(previous + 1), ...owners.slice(0, previous + 1)]
        const candidates = ordered.map((owner) => this.waiters.find((waiter) => waiter.request.owner === owner)!)
        let admitted = false
        for (const waiter of candidates) {
          const { request } = waiter
          const impossible = this.snapshot?.domains.some((domain) => (request.minimumBytes ?? 0) > domain.capacityBytes)
          if (impossible) {
            this.remove(waiter)
            waiter.reject(new Error("Request minimum exceeds hard capacity"))
            admitted = true
            break
          }
          const occupied = [...this.commitments].filter((lease) => lease.pool === request.pool).length
          if (request.pool && occupied >= (this.limits.get(request.pool) ?? 1)) continue
          if (request.bytes > status.headroomBytes) {
            // A known minimum can reserve future freed capacity; estimates alone cannot freeze the queue.
            if (request.minimumBytes && this.now() - waiter.queuedAt > 30_000) break
            continue
          }
          this.remove(waiter)
          const commitment: Commitment = { bytes: request.bytes, pool: request.pool }
          this.commitments.add(commitment)
          this.lastOwner = request.owner
          this.probeRevision = this.revision
          const probe = status.state !== "normal"
          waiter.resolve({
            checkpoint: (bytes) => {
              if (!this.commitments.has(commitment)) return
              if (!Number.isFinite(bytes) || bytes < 0 || bytes > commitment.bytes)
                throw new Error("A checkpoint can only consume a commitment")
              commitment.checkpoint = { bytes, revision: this.revision }
            },
            release: () => {
              if (!this.commitments.delete(commitment)) return
              if (probe && this.snapshot?.pressure === "normal") this.completedProbes++
              this.drain()
              this.options.changed?.()
            },
          })
          admitted = true
          break
        }
        if (!admitted) break
      }
    } finally {
      this.draining = false
    }
  }

  private remove(waiter: Waiter) {
    this.waiters.splice(this.waiters.indexOf(waiter), 1)
    waiter.removeAbort()
  }
}
