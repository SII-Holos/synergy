import { SQL } from "bun"
import { createHash } from "node:crypto"
import {
  databaseErrorCode,
  StorageClosedError,
  StorageCommitUnknownError,
  StorageOwnershipError,
  StorageIntegrityError,
} from "./errors"
import type { SqlConnection, SqlDriver, SqlRow, SqlTransactionOptions, SqlValue } from "./sql-contract"

function statement(sql: string) {
  let index = 0
  return sql.replace(/\?/g, () => `$${++index}`)
}

// Bun 1.3.14 uses errno for SQLSTATE and an asynchronous reserved-connection release.
// https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/js/bun/sql.ts
export class PostgresDriver implements SqlDriver {
  readonly backend = "postgres" as const
  private closed = false
  private ownershipLost = false
  private closing?: Promise<void>
  private constructor(
    private readonly pool: SQL,
    private readonly owner?: SQL,
    private readonly ownerIdentity?: { pid: number; classID: number; objectID: number },
  ) {}

  static async open(url: string, namespace: string, max = 8, readonly = false) {
    const options = {
      max: readonly ? Math.max(2, max) : Math.max(1, max - 1),
      bigint: true,
      connectionTimeout: 10,
      connection: {
        synchronous_commit: "on",
        statement_timeout: 30000,
        lock_timeout: 5000,
        idle_in_transaction_session_timeout: 30000,
      },
    }
    const pool = new SQL(url, options)
    let owner: SQL | undefined
    try {
      const [version] = await pool`SELECT current_setting('server_version_num')::integer AS version`
      if (Number(version.version) < 160000 || Number(version.version) >= 190000)
        throw new StorageIntegrityError("Authoritative storage requires PostgreSQL 16, 17, or 18")
      if (readonly) return new PostgresDriver(pool)
      owner = new SQL(url, { ...options, max: 1, idleTimeout: 0, maxLifetime: 0 })
      const digest = createHash("sha256").update(namespace).digest()
      const [lock] =
        await owner`SELECT pg_try_advisory_lock(${digest.readInt32BE(0)}, ${digest.readInt32BE(4)}) AS acquired`
      if (!lock.acquired) throw new StorageOwnershipError("Another Runtime owns this PostgreSQL namespace")
      const [identity] = await owner`SELECT pg_backend_pid() AS pid`
      return new PostgresDriver(pool, owner, {
        pid: Number(identity.pid),
        classID: digest.readUInt32BE(0),
        objectID: digest.readUInt32BE(4),
      })
    } catch (error) {
      if (owner) await owner.close({ timeout: 0 })
      await pool.close()
      throw error
    }
  }

  async query<Row extends SqlRow = SqlRow>(sql: string, values: SqlValue[] = []): Promise<Row[]> {
    if (this.closed) throw new StorageClosedError()
    return this.pool.unsafe(statement(sql), values) as unknown as Promise<Row[]>
  }

  async transaction<T>(
    body: (connection: SqlConnection) => Promise<T>,
    options: SqlTransactionOptions = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(body, options)
      } catch (error) {
        if (attempt >= 2 || !["40001", "40P01"].includes(databaseErrorCode(error) ?? "")) throw error
        await Bun.sleep(10 * 2 ** attempt + Math.floor(Math.random() * 10))
      }
    }
  }

  private async attempt<T>(
    body: (connection: SqlConnection) => Promise<T>,
    options: SqlTransactionOptions = {},
  ): Promise<T> {
    if (this.closed) throw new StorageClosedError()
    if (!options.readOnly) await this.assertOwnership()
    const connection = await this.pool.reserve()
    const query = <Row extends SqlRow = SqlRow>(sql: string, values: SqlValue[] = []) =>
      connection.unsafe(statement(sql), values) as unknown as Promise<Row[]>
    // A declared single statement is already atomic, so BEGIN/COMMIT would only
    // add round trips to an engine that guarantees no more than the statement
    // itself does.
    const transactional = !(options.readOnly && options.singleStatement)
    let committing = false
    try {
      if (transactional)
        await query(
          options.readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN ISOLATION LEVEL SERIALIZABLE",
        )
      if (transactional && !options.readOnly) await query("SET LOCAL synchronous_commit = on")
      const result = await body({ query })
      if (!options.readOnly) await this.assertOwnership()
      if (transactional) {
        committing = true
        await query("COMMIT")
      }
      return result
    } catch (error) {
      const code = databaseErrorCode(error)
      if (transactional) {
        try {
          await query("ROLLBACK")
        } catch {
          /* A broken connection is closed below. */
        }
      }
      if (committing && code !== "40001" && code !== "40P01")
        throw new StorageCommitUnknownError(options.operationID, error)
      throw error
    } finally {
      await connection.release()
    }
  }

  private async assertOwnership() {
    if (!this.owner || !this.ownerIdentity) throw new StorageOwnershipError("This PostgreSQL Handle is read-only")
    if (this.ownershipLost)
      throw new StorageOwnershipError("PostgreSQL Runtime ownership was lost; reopen through explicit recovery")
    const expected = this.ownerIdentity
    try {
      const [identity] = await this
        .owner`SELECT pg_backend_pid() AS pid, EXISTS(SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND classid::bigint = ${expected.classID} AND objid::bigint = ${expected.objectID} AND objsubid = 2 AND granted) AS held`
      if (Number(identity.pid) !== expected.pid || !identity.held)
        throw new StorageOwnershipError("PostgreSQL Runtime ownership was lost; reopen through explicit recovery")
    } catch (error) {
      this.ownershipLost = true
      throw new StorageOwnershipError("PostgreSQL Runtime ownership was lost; reopen through explicit recovery", {
        cause: error,
      })
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true
      try {
        if (this.owner && !this.ownershipLost) await this.owner`SELECT pg_advisory_unlock_all()`
      } finally {
        try {
          await this.owner?.close({ timeout: 0 })
        } finally {
          await this.pool.close()
        }
      }
    })()
    return this.closing
  }
}
