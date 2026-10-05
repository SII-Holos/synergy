import { StorageIntegrityError } from "./errors"
import type { SqlConnection, SqlValue } from "./sql-contract"

/** Inspect only the bootstrap DDL vocabulary owned by TransactionalStore. */
export async function missingPostgresSchema(connection: SqlConnection, statements: string[]) {
  const values: SqlValue[] = []
  const probes = statements.map((sql, position) => {
    const relation = /^CREATE (?:TABLE|INDEX) IF NOT EXISTS ([a-z_][a-z0-9_]*)\b/.exec(sql)
    const procedure = /^CREATE OR REPLACE FUNCTION ([a-z_][a-z0-9_]*)\(\)/.exec(sql)
    const trigger = /^CREATE OR REPLACE TRIGGER ([a-z_][a-z0-9_]*) .*? ON ([a-z_][a-z0-9_]*)\b/.exec(sql)
    if (relation || procedure) {
      values.push((relation ?? procedure)![1]! + (procedure ? "()" : ""))
      return `SELECT ${position} AS position WHERE ${relation ? "to_regclass" : "to_regprocedure"}(?) IS NULL`
    }
    if (trigger) {
      values.push(trigger[1]!, trigger[2]!)
      return `SELECT ${position} AS position WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = ? AND tgrelid = to_regclass(?))`
    }
    throw new StorageIntegrityError("Unsupported PostgreSQL bootstrap schema statement")
  })
  if (!probes.length) return []
  const rows = await connection.query(probes.join(" UNION ALL "), values)
  const missing = new Set(rows.map((row) => Number(row.position)))
  return statements.filter((_, position) => missing.has(position))
}
