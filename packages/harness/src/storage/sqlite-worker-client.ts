import { existsSync } from "node:fs"
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { StorageBusyError, StorageClosedError, StorageUnavailableError } from "./errors"
import { StorageBudgets } from "./budgets"
import { Log } from "../util/log"
import { ObservabilityIssues } from "../observability/issues"
import { ObservabilityMetrics } from "../observability/metrics"
import { sqlParameterBytes } from "./sql-contract"
import { beginStorageMaintenance } from "./maintenance-progress"
import type { StorageMaintenanceOperation } from "@ericsanchezok/synergy-util/runtime-startup"
import type { SqliteMaintenanceResult, SqliteRequest, SqliteResponse, SqlRow } from "./sql-contract"

const log = Log.create({ service: "storage.worker" })

// The worker answers one statement at a time from one event loop, so an
// unanswered probe means only that the loop is occupied — it cannot by itself
// distinguish a healthy worker running a long statement from a hung one. The
// two are separated on the *duration* of the silence: a probe timeout makes the
// driver busy, and only sustained silence past the hard ceiling is a wedge. One
// missed probe must never turn an overdue statement into a process restart.
type PendingRequest = {
  resolve(result: { rows: SqlRow[]; maintain?: SqliteMaintenanceResult }): void
  reject(error: unknown): void
  bytes: number
  probe: boolean
  // Wall clock advances across a host suspend while this monotonic budget does
  // not, so only the elapsed monotonic time may expire a request.
  dispatchedAt: number
  deadline: number
  lastProgressAt: number
  ceiling: number
  observe?(failed: boolean): void
  timeout?: ReturnType<typeof setTimeout>
  maintenance?: ReturnType<typeof beginStorageMaintenance>
}

export class SqliteWorkerClient {
  private readonly budgets = StorageBudgets.capture()
  private readonly worker: Bun.Subprocess
  private readonly pending = new Map<number, PendingRequest>()
  private sequence = 0
  private queuedBytes = 0
  private closed = false
  // Set when this driver tears the worker down itself, so an expected exit is
  // not reported as a terminal storage failure.
  private stopping = false
  private closing?: Promise<void>
  private unavailableError?: Error
  private readonly unavailableListeners = new Set<(error: Error) => void>()
  // Explicit worker state. `busy` is a degraded-but-alive worker whose event
  // loop is occupied; only `exited` and `latched` are terminal.
  private state: "healthy" | "busy" | "exited" | "latched" = "healthy"
  private monitoring?: Promise<boolean>

  constructor(readonly role: "reader" | "writer") {
    const entry = fileURLToPath(new URL("./sqlite-worker.ts", import.meta.url))
    this.worker = Bun.spawn({
      cmd: existsSync(entry) ? [process.execPath, "run", entry] : [process.execPath, "__storage-worker-runner"],
      env: { ...process.env, SYNERGY_STORAGE_PARENT_PID: String(process.pid) },
      // Group cancellation must leave storage alive until its owner drains terminal writes.
      detached: process.platform !== "win32",
      serialization: "advanced",
      stdout: "ignore",
      stderr: "inherit",
      ipc: (message: SqliteResponse) => {
        if (!this.pending.has(message.id)) return
        // A staged progress report proves the process is alive and advancing, so
        // it restarts the silence window without clearing the busy state: the
        // loop is still occupied by the statement that produced those stages.
        if (message.stage) {
          this.pending.get(message.id)!.lastProgressAt = performance.now()
          this.pending.get(message.id)?.maintenance?.stage(message.stage)
          return
        }
        // Any answer at all is proof the event loop is alive, so it both clears
        // the busy state and restarts the silence window that the ceiling is
        // measured against.
        this.observeResponse()
        if (message.error)
          this.settle(message.id, { error: Object.assign(new Error(message.error.message), message.error) })
        else this.settle(message.id, { rows: message.rows ?? [], maintain: message.maintain })
      },
      onExit: (_child, code) => {
        // Fence this connection immediately; the driver owns reader replacement
        // and escalates writer loss through Runtime shutdown.
        if (!this.stopping) {
          this.failTerminal(new StorageUnavailableError(`The SQLite worker exited with code ${code}`))
          return
        }
        this.closed = true
        for (const id of this.pending.keys())
          this.settle(id, { error: new Error(`SQLite worker exited with code ${code}`) })
      },
    })
  }

  private observeResponse() {
    this.leaveBusy()
  }

  private settle(id: number, result: { rows: SqlRow[]; maintain?: SqliteMaintenanceResult } | { error: unknown }) {
    const pending = this.pending.get(id)
    if (!pending) return
    if (pending.timeout) clearTimeout(pending.timeout)
    this.pending.delete(id)
    this.queuedBytes -= pending.bytes
    pending.maintenance?.finish("error" in result ? "failed" : "completed")
    pending.observe?.("error" in result)
    if ("error" in result) pending.reject(result.error)
    else pending.resolve({ rows: result.rows, maintain: result.maintain })
  }

  private failTerminal(error: Error) {
    if (this.unavailableError) return
    this.unavailableError = error
    this.closed = true
    this.stopping = true
    this.worker.kill()
    for (const id of this.pending.keys()) this.settle(id, { error })
    for (const listener of [...this.unavailableListeners]) listener(error)
  }

  onUnavailable(listener: (error: Error) => void): () => void {
    if (this.unavailableError) {
      listener(this.unavailableError)
      return () => {}
    }
    this.unavailableListeners.add(listener)
    return () => {
      this.unavailableListeners.delete(listener)
    }
  }

  /**
   * The budget for one statement, chosen by whether the work could have been split
   * rather than by how long it is expected to take.
   *
   * Only `reclaim` is splittable: it frees a bounded page count per call, so a
   * chunk budget it can actually meet is enforceable. Every other maintenance
   * operation is a single engine call — `VACUUM` rewrites every page, `PRAGMA
   * integrity_check` has no progress callback, `CREATE INDEX` has no partial form —
   * and each grows with the store, so measuring one against the chunk budget would
   * fail work that would have finished, and would fail an index build in the worst
   * way: rolled back, then rebuilt on every open. Those are governed by the
   * ceiling, which is what the ceiling exists to bound.
   */
  private statementBudget(operation?: StorageMaintenanceOperation): number {
    const budgets = this.budgets()
    if (!operation) return budgets.requestDeadlineMs
    return operation === "reclaim" ? budgets.chunkBudgetMs : budgets.engineBudgetMs
  }
  async request(request: Omit<SqliteRequest, "id">): Promise<{ rows: SqlRow[]; maintain?: SqliteMaintenanceResult }> {
    this.checkExit()
    if (this.unavailableError) return Promise.reject(this.unavailableError)
    if (this.closed) return Promise.reject(new StorageClosedError())
    // A degraded worker accepts no new work: queueing behind a statement that is
    // already over budget would only convert a fast, retryable busy into a long
    // wait. Work already dispatched keeps its own deadline and still gets the
    // full ceiling before anything terminal happens.
    if (this.state === "busy")
      return Promise.reject(new StorageBusyError("Authoritative storage is busy; retry when the worker answers"))
    // The budget follows whether the work could have been split; see
    // `statementBudget`.
    const deadline = this.statementBudget(request.maintenance)
    const bytes = sqlParameterBytes(request.values ?? [])
    if (this.queuedBytes + bytes > 32 * 1024 * 1024)
      return Promise.reject(new StorageBusyError("Authoritative storage byte queue is full"))
    const id = ++this.sequence
    const budgets = this.budgets()
    const startedAt = performance.now()
    const ceiling =
      request.maintenance && request.maintenance !== "reclaim" ? budgets.hardCeilingMs : budgets.ordinaryCeilingMs
    const fingerprint = request.statement
      ? createHash("sha256")
          .update(request.statement.replace(/'(?:[^']|'')*'/g, "?").replace(/\b\d+\b/g, "?"))
          .digest("hex")
          .slice(0, 16)
      : request.action
    const maintenance = request.maintenance
      ? beginStorageMaintenance(request.maintenance, deadline + budgets.probeAttempts * budgets.probeTimeoutMs)
      : undefined
    const promise = new Promise<{ rows: SqlRow[]; maintain?: SqliteMaintenanceResult }>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        bytes,
        probe: false,
        dispatchedAt: startedAt,
        lastProgressAt: startedAt,
        ceiling,
        deadline,
        maintenance,
        observe: AsyncLocalStorage.bind((failed) => {
          const duration = performance.now() - startedAt
          ObservabilityMetrics.record({
            name: "storage.sql.duration",
            value: duration,
            unit: "ms",
            module: "storage",
            labels: {
              role: this.role,
              fingerprint,
              status: failed ? "error" : "ok",
              maintenance: request.maintenance ?? "none",
            },
            sampleRate: failed || duration >= 1_000 ? 1 : 0.02,
          })
        }),
      })
    })
    this.queuedBytes += bytes
    this.arm(id, this.pending.get(id)!, deadline)
    try {
      this.worker.send({ ...request, id })
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ERR_IPC_CHANNEL_CLOSED")
        this.failTerminal(new StorageUnavailableError("The SQLite worker IPC channel closed", { cause: error }))
      else this.settle(id, { error })
    }
    return promise
  }

  private arm(id: number, pending: PendingRequest, delay: number) {
    if (this.pending.get(id) !== pending) return
    pending.timeout = setTimeout(() => this.review(id), delay)
  }

  // `setTimeout` fires on wall clock, which a host suspend consumes; the monotonic
  // budget is what decides whether the worker actually expired. A fire that
  // outran the budget was a suspend, so the request is re-armed and keeps waiting
  // instead of killing a worker that never saw the deadline pass.
  private review(id: number) {
    const pending = this.pending.get(id)
    if (!pending) return
    const elapsed = performance.now() - pending.dispatchedAt
    if (elapsed < pending.deadline) {
      this.arm(id, pending, Math.max(1, pending.deadline - elapsed))
      return
    }
    if (pending.probe) {
      // An unanswered probe means the worker's event loop is occupied. It does
      // not mean the worker is gone, so the silence is recorded rather than
      // escalated, and the reason reaches the metrics and the log instead of
      // being discarded when the probe settles.
      ObservabilityMetrics.record({
        name: "storage.worker.probe.timeout",
        value: 1,
        unit: "count",
        module: "storage",
      })
      this.settle(id, { error: new StorageBusyError("SQLite worker did not answer a liveness probe") })
      return
    }
    void this.evaluate(id)
  }

  /** Declares the worker occupied. Idempotent, so a long silence reports once. */
  private enterBusy(ceilingMs: number) {
    if (this.state === "busy" || this.state === "latched") return
    this.state = "busy"
    const budgets = this.budgets()
    log.warn("SQLite worker is busy; storage is degraded until it answers", {
      ceilingMs,
      role: this.role,
    })
    ObservabilityIssues.raise({
      code: "STORAGE_WORKER_BUSY",
      severity: "warning",
      module: "storage",
      title: "Authoritative storage is degraded",
      message:
        "The SQLite worker stopped answering liveness probes, so its event loop is occupied by a statement. Storage is degraded and accepts no new work until the worker answers; the runtime keeps running.",
      recommendation:
        "Confirm no maintenance or migration statement exceeds the chunk budget, then inspect storage.queue.hold and storage.operation.duration for the occupying statement.",
      evidence: { ceilingMs, role: this.role, probeTimeoutMs: budgets.probeTimeoutMs },
    })
    ObservabilityMetrics.record({
      name: "storage.worker.busy",
      value: 1,
      unit: "count",
      module: "storage",
    })
  }

  private leaveBusy() {
    if (this.state !== "busy") return
    this.state = "healthy"
    log.info("SQLite worker answered again; storage is healthy")
    ObservabilityMetrics.record({
      name: "storage.worker.recovered",
      value: 1,
      unit: "count",
      module: "storage",
    })
  }

  private async evaluate(id: number) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.enterBusy(pending.ceiling)
    const responsive = await this.monitorWorker(pending)
    if (this.closed || this.unavailableError || !this.pending.has(id)) return
    if (responsive) {
      // The worker answered, so only this request exceeded its budget.
      this.settle(id, { error: new StorageBusyError("SQLite worker exceeded its request deadline") })
      return
    }
    this.state = "exited"
    this.failTerminal(
      new StorageUnavailableError(
        "The SQLite worker did not answer a liveness probe within its recovery ceiling and cannot be recovered",
      ),
    )
  }

  private monitorWorker(pending: PendingRequest): Promise<boolean> {
    if (this.monitoring) return this.monitoring
    const run = (async (): Promise<boolean> => {
      try {
        const budgets = this.budgets()
        for (let consecutive = 0; ; consecutive++) {
          if (this.closed || this.unavailableError) return false
          const remaining = pending.ceiling - (performance.now() - pending.lastProgressAt)
          if (remaining <= 0) return false
          if (
            await this.ping(Math.min(budgets.probeTimeoutMs, pending.ceiling <= 60_000 ? 5_000 : Infinity, remaining))
          )
            return true
          if (consecutive + 1 >= budgets.probeAttempts) this.enterBusy(pending.ceiling)
          if (performance.now() - pending.lastProgressAt >= pending.ceiling) return false
        }
      } finally {
        this.monitoring = undefined
      }
    })()
    this.monitoring = run
    return run
  }

  private ping(timeoutMs: number): Promise<boolean> {
    // A probe is pointless once this driver already gave up on the worker; the
    // terminal failure was reported when it happened.
    if (this.unavailableError || this.closed) return Promise.resolve(false)
    const id = ++this.sequence
    return new Promise<boolean>((resolve) => {
      const pending: PendingRequest = {
        resolve: () => resolve(true),
        reject: () => resolve(false),
        bytes: 0,
        probe: true,
        dispatchedAt: performance.now(),
        lastProgressAt: performance.now(),
        ceiling: timeoutMs,
        deadline: timeoutMs,
      }
      this.pending.set(id, pending)
      this.arm(id, pending, timeoutMs)
      try {
        this.worker.send({ action: "ping", id })
      } catch (error) {
        this.settle(id, { error })
      }
    })
  }

  get status() {
    this.checkExit()
    return this.closed ? ("closed" as const) : this.state
  }

  get unavailable() {
    this.checkExit()
    return this.unavailableError
  }

  private checkExit() {
    if (!this.closed && !this.stopping && (this.worker.exitCode != null || this.worker.signalCode != null))
      this.failTerminal(new StorageUnavailableError("The SQLite worker exited before its connection was closed"))
  }

  close(deadlineAt = performance.now() + this.budgets().teardownBudgetMs): Promise<void> {
    this.closing ??= (async () => {
      const remaining = () => Math.max(1, deadlineAt - performance.now())
      this.stopping = true
      try {
        if (!this.closed) await this.within(this.request({ action: "close" }), remaining(), "worker close")
      } catch (error) {
        log.warn("storage worker did not finish closing; terminating owned process", { role: this.role, error })
      } finally {
        this.closed = true
        this.worker.kill()
        for (const id of this.pending.keys()) this.settle(id, { error: new StorageClosedError() })
        await this.within(this.worker.exited, remaining(), "worker exit").catch(() => {})
      }
    })()
    return this.closing
  }

  private within<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer: ReturnType<typeof setTimeout> = setTimeout(
        () => reject(new StorageBusyError(`SQLite ${label} exceeded ${ms}ms`)),
        ms,
      )
      task.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }
}
