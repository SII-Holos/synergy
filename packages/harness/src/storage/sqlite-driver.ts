import { MaintenanceProgress } from "./maintenance-progress"
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
import { ServerProcessLock } from "../util/server-process-lock"
import { StorageQueue } from "./queue"
import { sqlParameterBytes } from "./sql-contract"
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

// A probe is answered from the worker's own event loop, so it only replies once
// the ordinary statement occupying that loop returns; a healthy worker running a
// long statement is therefore indistinguishable from a hung one until the
// statement finishes. The probe budget mirrors the ordinary request deadline and
// is retried a bounded number of times, because a false kill turns one overdue
// request into a whole-process restart.
const PROBE_TIMEOUT_MS = 30_000
const PROBE_ATTEMPTS = 3

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
        for (const pending of this.pending.values()) {
          if (pending.timeout) clearTimeout(pending.timeout)
          pending.reject(new Error(`SQLite worker exited with code ${code}`))
        }
        this.pending.clear()
        this.queuedBytes = 0
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

  private settle(id: number, result: { rows: SqlRow[]; maintain?: SqliteMaintenanceResult } | { error: unknown }) {
    const pending = this.pending.get(id)
    if (!pending) return
    if (pending.timeout) clearTimeout(pending.timeout)
    this.pending.delete(id)
    this.queuedBytes -= pending.bytes
    if ("error" in result) pending.reject(result.error)
    else pending.resolve({ rows: result.rows, maintain: result.maintain })
  }

  private failTerminal(error: Error) {
    if (this.unavailableError) return
    this.unavailableError = error
    this.closed = true
    this.stopping = true
    this.worker.kill()
    for (const pending of [...this.pending.values()]) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
    this.queuedBytes = 0
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

  private async request(
    request: Omit<SqliteRequest, "id">,
    onMaintenanceBudget?: (timeoutMs: number) => void,
  ): Promise<{ rows: SqlRow[]; maintain?: SqliteMaintenanceResult }> {
    if (this.unavailableError) return Promise.reject(this.unavailableError)
    if (this.closed) return Promise.reject(new StorageClosedError())
    let deadline = 30_000
    if (request.maintenance || request.action === "maintain") {
      // Offline maintenance may rewrite every page; the finite deadline scales
      // with the current snapshot size, including uncheckpointed WAL growth.
      const { rows: pages } = await this.request({
        action: "query",
        reader: request.reader,
        statement: "PRAGMA page_count",
      })
      const { rows: size } = await this.request({
        action: "query",
        reader: request.reader,
        statement: "PRAGMA page_size",
      })
      const bytes = Number(pages[0]?.page_count ?? 0) * Number(size[0]?.page_size ?? 0)
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new StorageIntegrityError("SQLite maintenance size is invalid")
      // Full integrity checks revisit every index entry (https://sqlite.org/pragma.html#pragma_integrity_check).
      deadline = Math.min(2_147_483_647, 600_000 + Math.ceil(bytes / 1024 ** 2) * 1000)
      if (onMaintenanceBudget) onMaintenanceBudget(deadline)
      else MaintenanceProgress.announce(deadline)
    }
    const bytes = sqlParameterBytes(request.values ?? [])
    if (this.queuedBytes + bytes > 32 * 1024 * 1024)
      return Promise.reject(new StorageBusyError("Authoritative storage byte queue is full"))
    const id = ++this.sequence
    const promise = new Promise<{ rows: SqlRow[]; maintain?: SqliteMaintenanceResult }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, bytes, probe: false, dispatchedAt: performance.now(), deadline })
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
      this.settle(id, { error: new StorageBusyError("SQLite worker did not answer a liveness probe") })
      return
    }
    void this.evaluate(id)
  }

  private async evaluate(id: number) {
    if (!this.pending.has(id)) return
    if (!(await this.probeWorker())) {
      this.failTerminal(
        new StorageUnavailableError("The SQLite worker did not answer a liveness probe and cannot be recovered"),
      )
      return
    }
    // The worker answered, so only this request exceeded its budget.
    this.settle(id, { error: new StorageBusyError("SQLite worker exceeded its request deadline") })
  }

  private probeWorker(): Promise<boolean> {
    this.probing ??= (async () => {
      try {
        for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
          if (await this.ping()) return true
        }
        return false
      } finally {
        this.probing = undefined
      }
    })()
    return this.probing
  }

  private ping(): Promise<boolean> {
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
        deadline: PROBE_TIMEOUT_MS,
      }
      this.pending.set(id, pending)
      this.arm(id, pending, PROBE_TIMEOUT_MS)
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
    const result = await this.writerQueue.run(() =>
      this.request({ action: "maintain", maintain: request, maintenance: true }),
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
      this.request(
        { action: "query", reader: true, statement, values, maintenance: options?.maintenance },
        options?.onMaintenanceBudget,
      ),
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
          await this.request(
            {
              action: "query",
              reader: options.readOnly,
              statement,
              values,
              maintenance: queryOptions?.maintenance,
            },
            queryOptions?.onMaintenanceBudget,
          )
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
      try {
        await Promise.all([this.writerQueue.close(), this.readerQueue.close()])
        if (!this.closed) await this.request({ action: "close" })
      } finally {
        this.stopping = true
        this.closed = true
        this.worker.kill()
        await this.worker.exited
        await this.ownership?.release()
      }
    })()
    return this.closing
  }
}
