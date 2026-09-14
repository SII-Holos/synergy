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
} from "./errors"
import { ServerProcessLock } from "../util/server-process-lock"
import { StorageQueue } from "./queue"
import type { SqlConnection, SqlDriver, SqliteRequest, SqliteResponse, SqlRow, SqlValue } from "./sql-contract"

export class SqliteDriver implements SqlDriver {
  readonly backend = "sqlite" as const
  private readonly worker: Bun.Subprocess
  private readonly writerQueue = new StorageQueue()
  private readonly readerQueue = new StorageQueue()
  private readonly pending = new Map<
    number,
    {
      resolve(rows: SqlRow[]): void
      reject(error: unknown): void
      bytes: number
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  private sequence = 0
  private queuedBytes = 0
  private closed = false
  private closing?: Promise<void>

  private constructor(private readonly ownership?: { release(): Promise<void> }) {
    const entry = fileURLToPath(new URL("./sqlite-worker.ts", import.meta.url))
    this.worker = Bun.spawn({
      cmd: existsSync(entry) ? [process.execPath, "run", entry] : [process.execPath, "__storage-worker-runner"],
      env: { ...process.env, SYNERGY_STORAGE_PARENT_PID: String(process.pid) },
      serialization: "advanced",
      stdout: "ignore",
      stderr: "inherit",
      ipc: (message: SqliteResponse) => {
        const pending = this.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timeout)
        this.pending.delete(message.id)
        this.queuedBytes -= pending.bytes
        if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error))
        else pending.resolve(message.rows ?? [])
      },
      onExit: (_child, code) => {
        this.closed = true
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout)
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
      if (!readonly && process.platform !== "win32") await fs.chmod(filename, 0o600)
      return driver
    } catch (error) {
      driver.worker.kill()
      await driver.worker.exited
      await ownership?.release()
      throw error
    }
  }

  private request(request: Omit<SqliteRequest, "id">): Promise<SqlRow[]> {
    if (this.closed) return Promise.reject(new StorageClosedError())
    const bytes = (request.values ?? []).reduce<number>(
      (total, value) =>
        total +
        (typeof value === "string" ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 8),
      0,
    )
    if (this.queuedBytes + bytes > 32 * 1024 * 1024)
      return Promise.reject(new StorageBusyError("Authoritative storage byte queue is full"))
    const id = ++this.sequence
    const promise = new Promise<SqlRow[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.closed = true
        this.worker.kill()
        reject(new StorageBusyError("SQLite worker exceeded its request deadline"))
      }, 30_000)
      this.pending.set(id, { resolve, reject, bytes, timeout })
    })
    this.queuedBytes += bytes
    try {
      this.worker.send({ ...request, id })
    } catch (error) {
      const pending = this.pending.get(id)!
      clearTimeout(pending.timeout)
      this.pending.delete(id)
      this.queuedBytes -= bytes
      pending.reject(error)
    }
    return promise
  }

  query<Row extends SqlRow = SqlRow>(statement: string, values: SqlValue[] = []): Promise<Row[]> {
    return this.readerQueue.run(() => this.request({ action: "query", reader: true, statement, values })) as Promise<
      Row[]
    >
  }

  transaction<T>(
    body: (connection: SqlConnection) => Promise<T>,
    options: { readOnly?: boolean; operationID?: string } = {},
  ): Promise<T> {
    const queue = options.readOnly ? this.readerQueue : this.writerQueue
    return queue.run(async () => {
      const query = <Row extends SqlRow = SqlRow>(statement: string, values: SqlValue[] = []) =>
        this.request({ action: "query", reader: options.readOnly, statement, values }) as Promise<Row[]>
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
        this.closed = true
        this.worker.kill()
        await this.worker.exited
        await this.ownership?.release()
      }
    })()
    return this.closing
  }
}
