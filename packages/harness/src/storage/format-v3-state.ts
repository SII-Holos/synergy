import { z } from "zod"
import type { SqlConnection } from "./sql-contract"
import type { TransactionalStore } from "./transactional-store"
import { StorageConflictError, StorageIntegrityError } from "./errors"

export namespace StorageFormatV3State {
  export const table = "storage_format_v3_state"
  export const Schema = z
    .object({
      version: z.literal(3),
      phase: z.enum(["records", "nodes", "artifacts", "swap", "reclaim", "complete"]),
      recordsCursor: z.string(),
      nodesCursor: z.string(),
      artifactsCursor: z.string(),
      fenced: z.boolean().optional(),
      invalidated: z.boolean().optional(),
      paused: z.boolean().optional(),
      releasedPages: z.number().int().nonnegative().optional(),
      remainingPages: z.number().int().nonnegative().optional(),
      reclaimError: z.string().optional(),
    })
    .passthrough()
  export type State = z.infer<typeof Schema>

  export function parse(value: string): State {
    try {
      return Schema.parse(JSON.parse(value))
    } catch {
      throw new StorageIntegrityError(
        "The format upgrade checkpoint is invalid; preserve the database and export diagnostics",
      )
    }
  }

  export async function read(store: TransactionalStore): Promise<State | undefined> {
    if (store.options.backend !== "sqlite") return
    return store.snapshot(async (tx) => {
      const [exists] = await tx.raw.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table])
      if (!exists) return
      const [row] = await tx.raw.query<{ state: string }>(`SELECT state FROM ${table} WHERE namespace = ?`, [
        store.options.namespace,
      ])
      return row ? parse(row.state) : undefined
    })
  }

  export async function write(connection: SqlConnection, namespace: string, state: State) {
    await connection.query(
      `INSERT INTO ${table}(namespace, state) VALUES (?, ?) ON CONFLICT(namespace) DO UPDATE SET state = excluded.state`,
      [namespace, JSON.stringify(state)],
    )
  }

  export async function update(store: TransactionalStore, change: (state: State) => State) {
    return store.transaction(async (tx) => {
      const [row] = await tx.raw.query<{ state: string }>(`SELECT state FROM ${table} WHERE namespace = ?`, [
        store.options.namespace,
      ])
      if (!row) return
      const next = change(parse(row.state))
      await write(tx.raw, store.options.namespace, next)
      return next
    })
  }

  export async function assertUnchanged(connection: SqlConnection, namespace: string) {
    const [row] = await connection.query<{ state: string }>(`SELECT state FROM ${table} WHERE namespace = ?`, [
      namespace,
    ])
    if (row && parse(row.state).invalidated)
      throw new StorageConflictError(
        "The source changed after the format copy began; resume maintenance to rebuild its staging tables",
      )
  }

  const sources = ["storage_records", "storage_artifacts"] as const
  const operations = ["INSERT", "UPDATE", "DELETE"] as const
  export function fences(install: boolean) {
    return sources.flatMap((source) =>
      operations.map((operation) => {
        const name = `format_v3_${source}_${operation.toLowerCase()}`
        const row = operation === "DELETE" ? "OLD" : "NEW"
        return {
          statement: install
            ? `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${operation} ON ${source} WHEN EXISTS (SELECT 1 FROM ${table} WHERE namespace = ${row}.namespace AND json_extract(state, '$.phase') IN ('records', 'nodes', 'artifacts', 'swap') AND COALESCE(json_extract(state, '$.invalidated'), 0) = 0) BEGIN UPDATE ${table} SET state = json_set(state, '$.invalidated', json('true')) WHERE namespace = ${row}.namespace; END`
            : `DROP TRIGGER IF EXISTS ${name}`,
        }
      }),
    )
  }
}
