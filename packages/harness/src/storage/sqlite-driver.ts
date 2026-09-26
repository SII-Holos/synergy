import fs from "node:fs/promises"
import path from "node:path"
import {
  StorageBusyError,
  StorageClosedError,
  StorageCommitUnknownError,
  StorageIntegrityError,
  StorageOwnershipError,
} from "./errors"
import { StorageBudgets } from "./budgets"
import { Log } from "../util/log"
import { ServerProcessLock } from "../util/server-process-lock"
import { StorageQueue } from "./queue"
import { SqliteWorkerClient } from "./sqlite-worker-client"
import type {
  SqlConnection,
  SqlDriver,
  SqlQueryOptions,
  SqlTransactionOptions,
  SqlRow,
  SqlValue,
  SqliteMaintenanceRequest,
  SqliteMaintenanceResult,
} from "./sql-contract"

const log = Log.create({ service: "storage.driver" })

export class SqliteDriver implements SqlDriver {
  readonly backend = "sqlite" as const
  private readonly budgets = StorageBudgets.capture()
  private readonly writer = new SqliteWorkerClient("writer")
  private reader = new SqliteWorkerClient("reader")
  private readonly writerQueue = new StorageQueue("sqlite.writer")
  private readonly readerQueue = new StorageQueue("sqlite.reader")
  private closed = false
  private closing?: Promise<void>
  private readerRetryAt = 0

  private constructor(
    private readonly filename: string,
    private readonly ownership?: { release(): Promise<void> },
  ) {}

  private check() {
    if (this.closed || this.closing) throw new StorageClosedError()
    if (this.writer.unavailable) throw this.writer.unavailable
  }

  onUnavailable(listener: (error: Error) => void) {
    return this.writer.onUnavailable(listener)
  }

  get status() {
    return { reader: this.reader.status, writer: this.writer.status, closing: this.closed || Boolean(this.closing) }
  }

  private async readWorker() {
    this.check()
    if (!this.reader.unavailable && this.reader.status !== "closed") return this.reader
    if (performance.now() < this.readerRetryAt)
      throw this.reader.unavailable ?? new StorageBusyError("Storage reader is recovering; retry shortly")
    this.readerRetryAt = performance.now() + 5_000
    await this.reader.close()
    this.reader = new SqliteWorkerClient("reader")
    try {
      await this.reader.request({ action: "open", filename: this.filename, readonly: true })
    } catch (error) {
      await this.reader.close()
      throw error
    }
    return this.reader
  }

  private async readRequest(statement: string, values: SqlValue[], options?: SqlQueryOptions) {
    return (await this.readWorker()).request({ action: "query", statement, values, maintenance: options?.maintenance })
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
    const driver = new SqliteDriver(filename, ownership)
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
      await driver.writer.request({ action: "open", filename, readonly })
      await driver.reader.request({ action: "open", filename, readonly: true })
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
      await driver.close()
      throw error
    }
  }

  async walPressure() {
    return this.writerQueue.run(async () => {
      const { rows } = await this.writer.request({ action: "query", statement: "PRAGMA wal_checkpoint(PASSIVE)" })
      const { rows: sizes } = await this.writer.request({ action: "query", statement: "PRAGMA page_size" })
      const pending = Math.max(0, Number(rows[0]?.log ?? 0) - Number(rows[0]?.checkpointed ?? 0))
      return pending * Number(sizes[0]?.page_size ?? 4096)
    })
  }

  async maintain(request: SqliteMaintenanceRequest): Promise<SqliteMaintenanceResult> {
    // Converting a store to incremental auto-vacuum rewrites every page with one
    // `VACUUM`, which cannot be split, so `statementBudget` bounds it by the
    // ceiling. Reclaim is the exception: it frees a bounded page count per call
    // and stays on the chunk budget.
    const execute = () =>
      this.writerQueue.run(() =>
        this.writer.request({
          action: "maintain",
          maintain: request,
          maintenance: request.operation === "enable-incremental-vacuum" ? "vacuum" : "reclaim",
        }),
      )
    const result =
      request.operation === "enable-incremental-vacuum" ? await this.readerQueue.run(execute) : await execute()
    if (!result.maintain) throw new StorageIntegrityError("SQLite maintenance returned no result")
    return result.maintain
  }

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    values: SqlValue[] = [],
    options?: SqlQueryOptions,
  ): Promise<Row[]> {
    const result = await this.readerQueue.run(() => this.readRequest(statement, values, options))
    return result.rows as Row[]
  }

  transaction<T>(body: (connection: SqlConnection) => Promise<T>, options: SqlTransactionOptions = {}): Promise<T> {
    const queue = options.readOnly ? this.readerQueue : this.writerQueue
    return queue.run(async () => {
      this.check()
      const worker = options.readOnly ? await this.readWorker() : this.writer
      const query = async <Row extends SqlRow = SqlRow>(
        statement: string,
        values: SqlValue[] = [],
        queryOptions?: SqlQueryOptions,
      ) =>
        (
          await worker.request({
            action: "query",
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
      const deadlineAt = performance.now() + this.budgets().teardownBudgetMs
      const remaining = () => Math.max(1, deadlineAt - performance.now())
      try {
        await this.within(Promise.all([this.writerQueue.close(), this.readerQueue.close()]), remaining(), "queue drain")
      } catch (error) {
        log.warn("storage queues did not drain before shutdown", { error })
      } finally {
        this.closed = true
        await Promise.all([this.writer.close(deadlineAt), this.reader.close(deadlineAt)])
        await this.ownership?.release()
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
