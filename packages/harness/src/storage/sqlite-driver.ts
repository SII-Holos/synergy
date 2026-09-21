import fs from "node:fs/promises"
import path from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  StorageBusyError,
  StorageClosedError,
  StorageCommitUnknownError,
  StorageIntegrityError,
  StorageOwnershipError,
  StorageUnavailableError,
} from "./errors"
import { StorageBudgets } from "./budgets"
import { Log } from "../util/log"
import { ObservabilityIssues } from "../observability/issues"
import { ObservabilityMetrics } from "../observability/metrics"
import { ServerProcessLock } from "../util/server-process-lock"
import { StorageQueue } from "./queue"
import { sqlParameterBytes } from "./sql-contract"
import { beginStorageMaintenance } from "./maintenance-progress"
import type { StorageMaintenanceOperation } from "@ericsanchezok/synergy-util/runtime-startup"
import type {
  SqlConnection,
  SqlDriver,
  SqlQueryOptions,
  SqlTransactionOptions,
  SqliteMaintenanceRequest,
  SqliteMaintenanceResult,
  SqliteRequest,
  SqliteResponse,
  SqlRow,
  SqlValue,
} from "./sql-contract"

const log = Log.create({ service: "storage.driver" })

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
  timeout?: ReturnType<typeof setTimeout>
  maintenance?: ReturnType<typeof beginStorageMaintenance>
}

export class SqliteDriver implements SqlDriver {
  readonly backend = "sqlite" as const
  private readonly worker: Bun.Subprocess
  private readonly writerQueue = new StorageQueue("sqlite.writer")
  private readonly readerQueue = new StorageQueue("sqlite.reader")
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
  private probing?: Promise<boolean>
  // Explicit worker state. `busy` is a degraded-but-alive worker whose event
  // loop is occupied; only `exited` and `latched` are terminal.
  private state: "healthy" | "busy" | "exited" | "latched" = "healthy"
  // Set when a probe fails and cleared when one succeeds. Its presence is what
  // keeps the monitor probing until the worker answers or the ceiling passes.
  private unresponsiveSince?: number
  private monitoring?: Promise<boolean>

  private constructor(private readonly ownership?: { release(): Promise<void> }) {
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
          this.observeProgress()
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
        // An exit this driver did not ask for is unrecoverable: the store cannot
        // re-establish its worker, so the host must restart rather than serve.
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

  static async open(filename: string, readonly = false, mustExist = false) {
    if (!readonly) await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
    let ownership: { release(): Promise<void> } | undefined
    if (!readonly) {
      try {
        ownership = await ServerProcessLock.acquire(`${filename}.owner`, "oneshot")
      } catch (error) {
        if (error instanceof ServerProcessLock.AlreadyRunningError)
          throw new StorageOwnershipError("Another Runtime owns this SQLite database", { cause: error })
        throw error
      }
    }
    const driver = new SqliteDriver(ownership)
    try {
      if (mustExist) {
        try {
          await fs.access(filename)
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            throw new StorageIntegrityError("The active SQLite database is missing")
          throw error
        }
      }
      await driver.request({ action: "open", filename, readonly })
      if (!readonly && process.platform !== "win32") {
        // The worker's umask keeps new files owner-only; chmod also repairs
        // sidecars left behind by an older engine before this invariant.
        for (const suffix of ["", "-wal", "-shm"]) {
          try {
            await fs.chmod(`${filename}${suffix}`, 0o600)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }
        }
      }
      return driver
    } catch (error) {
      driver.stopping = true
      driver.worker.kill()
      await driver.worker.exited
      await ownership?.release()
      throw error
    }
  }

  private observeResponse() {
    this.unresponsiveSince = undefined
    this.leaveBusy()
  }

  // A staged maintenance report proves the worker is alive and advancing, but not
  // that it is free: the stage came from the very statement occupying the loop. It
  // therefore restarts the silence window the ceiling is measured against without
  // clearing the busy state, so a long rewrite that keeps reporting stages is
  // neither mistaken for a wedge nor reported healthy while it still blocks work.
  private observeProgress() {
    this.unresponsiveSince = undefined
  }

  private settle(id: number, result: { rows: SqlRow[]; maintain?: SqliteMaintenanceResult } | { error: unknown }) {
    const pending = this.pending.get(id)
    if (!pending) return
    if (pending.timeout) clearTimeout(pending.timeout)
    this.pending.delete(id)
    this.queuedBytes -= pending.bytes
    pending.maintenance?.finish("error" in result ? "failed" : "completed")
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
    const budgets = StorageBudgets.current()
    if (!operation) return budgets.requestDeadlineMs
    return operation === "reclaim" ? budgets.chunkBudgetMs : budgets.engineBudgetMs
  }
  private async request(
    request: Omit<SqliteRequest, "id">,
  ): Promise<{ rows: SqlRow[]; maintain?: SqliteMaintenanceResult }> {
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
    const budgets = StorageBudgets.current()
    const maintenance = request.maintenance
      ? beginStorageMaintenance(request.maintenance, deadline + budgets.probeAttempts * budgets.probeTimeoutMs)
      : undefined
    const promise = new Promise<{ rows: SqlRow[]; maintain?: SqliteMaintenanceResult }>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        bytes,
        probe: false,
        dispatchedAt: performance.now(),
        deadline,
        maintenance,
      })
    })
    this.queuedBytes += bytes
    this.arm(id, this.pending.get(id)!, deadline)
    try {
      this.worker.send({ ...request, id })
    } catch (error) {
      this.settle(id, { error })
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
      this.unresponsiveSince ??= performance.now()
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
  private enterBusy() {
    if (this.state === "busy" || this.state === "latched") return
    this.state = "busy"
    const budgets = StorageBudgets.current()
    log.warn("SQLite worker is busy; storage is degraded until it answers", {
      ceilingMs: budgets.hardCeilingMs,
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
      evidence: { ceilingMs: budgets.hardCeilingMs, probeTimeoutMs: budgets.probeTimeoutMs },
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
    if (!this.pending.has(id)) return
    // The worker is probed until it answers or the silence outlasts the
    // ceiling. `probeAttempts` is how many unanswered probes it takes to call
    // the worker occupied; the ceiling is what finally calls it wedged.
    if (await this.monitorWorker()) {
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

  private monitorWorker(): Promise<boolean> {
    if (this.monitoring) return this.monitoring
    const run = (async (): Promise<boolean> => {
      try {
        const budgets = StorageBudgets.current()
        for (let consecutive = 0; ; consecutive++) {
          if (await this.ping()) return true
          if (consecutive + 1 >= budgets.probeAttempts) this.enterBusy()
          const silent = performance.now() - (this.unresponsiveSince ?? performance.now())
          if (silent >= budgets.hardCeilingMs) return false
        }
      } finally {
        this.monitoring = undefined
      }
    })()
    this.monitoring = run
    return run
  }

  private ping(): Promise<boolean> {
    // A probe is pointless once this driver already gave up on the worker; the
    // terminal failure was reported when it happened.
    if (this.unavailableError || this.closed) return Promise.resolve(false)
    const timeoutMs = StorageBudgets.current().probeTimeoutMs
    const id = ++this.sequence
    return new Promise<boolean>((resolve) => {
      const pending: PendingRequest = {
        resolve: () => resolve(true),
        reject: () => resolve(false),
        bytes: 0,
        probe: true,
        dispatchedAt: performance.now(),
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

  async walPressure() {
    return this.writerQueue.run(async () => {
      const { rows } = await this.request({ action: "query", statement: "PRAGMA wal_checkpoint(PASSIVE)" })
      const { rows: sizes } = await this.request({ action: "query", statement: "PRAGMA page_size" })
      const pending = Math.max(0, Number(rows[0]?.log ?? 0) - Number(rows[0]?.checkpointed ?? 0))
      return pending * Number(sizes[0]?.page_size ?? 4096)
    })
  }

  async maintain(request: SqliteMaintenanceRequest): Promise<SqliteMaintenanceResult> {
    // Converting a store to incremental auto-vacuum rewrites every page with one
    // `VACUUM`, which cannot be split, so `statementBudget` bounds it by the
    // ceiling. Reclaim is the exception: it frees a bounded page count per call
    // and stays on the chunk budget.
    const result = await this.writerQueue.run(() =>
      this.request({
        action: "maintain",
        maintain: request,
        maintenance: request.operation === "enable-incremental-vacuum" ? "vacuum" : "reclaim",
      }),
    )
    if (!result.maintain) throw new StorageIntegrityError("SQLite maintenance returned no result")
    return result.maintain
  }

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    values: SqlValue[] = [],
    options?: SqlQueryOptions,
  ): Promise<Row[]> {
    const result = await this.readerQueue.run(() =>
      this.request({ action: "query", reader: true, statement, values, maintenance: options?.maintenance }),
    )
    return result.rows as Row[]
  }

  transaction<T>(body: (connection: SqlConnection) => Promise<T>, options: SqlTransactionOptions = {}): Promise<T> {
    const queue = options.readOnly ? this.readerQueue : this.writerQueue
    return queue.run(async () => {
      const query = async <Row extends SqlRow = SqlRow>(
        statement: string,
        values: SqlValue[] = [],
        queryOptions?: SqlQueryOptions,
      ) =>
        (
          await this.request({
            action: "query",
            reader: options.readOnly,
            statement,
            values,
            maintenance: queryOptions?.maintenance,
          })
        ).rows as Row[]
      // A declared single statement is already atomic, so BEGIN/COMMIT would
      // cost this worker two extra IPC round trips for no consistency gain.
      if (options.readOnly && options.singleStatement) return body({ query })
      await query(options.readOnly ? "BEGIN" : "BEGIN IMMEDIATE")
      let committing = false
      try {
        const value = await body({ query })
        committing = true
        await query("COMMIT")
        return value
      } catch (error) {
        try {
          await query("ROLLBACK")
        } catch {
          if (committing) throw new StorageCommitUnknownError(options.operationID, error)
        }
        throw error
      }
    })
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      // A drain must be bounded, and bounded well below the worker ceiling. The
      // host that asked for this close is itself on a shutdown deadline and exits
      // non-zero when cleanup outlasts it, discarding whatever is queued behind
      // storage — including terminal writes that settle only during shutdown. So
      // every step here draws from one small shared budget: bounding each step by
      // the ceiling separately would let the sequence outlive the process that
      // requested it, and the worker is killed once the budget runs out.
      const deadlineAt = performance.now() + StorageBudgets.current().teardownBudgetMs
      const remaining = () => Math.max(1, deadlineAt - performance.now())
      try {
        await this.within(Promise.all([this.writerQueue.close(), this.readerQueue.close()]), remaining(), "queue drain")
        if (!this.closed) await this.within(this.request({ action: "close" }), remaining(), "worker close")
      } catch (error) {
        // Bounded teardown continues regardless: the worker is killed below, so a
        // drain that ran out of budget is reported rather than propagated as a
        // shutdown failure.
        log.warn("authoritative storage teardown exceeded its budget; killing the worker", { error })
      } finally {
        this.stopping = true
        this.closed = true
        this.worker.kill()
        await this.within(this.worker.exited, remaining(), "worker exit").catch(() => {})
        await this.ownership?.release()
      }
    })()
    return this.closing
  }

  /**
   * Bounds a teardown step. A rejected timer is not an error path: the caller
   * treats a timeout as "this step did not finish" and escalates by killing the
   * worker, which is what actually unblocks the process.
   */
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
