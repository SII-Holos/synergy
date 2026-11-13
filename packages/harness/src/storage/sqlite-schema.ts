import { StorageIntegrityError } from "./errors"
import type { SqlConnection, SqlValue } from "./sql-contract"

// Interpret only TransactionalStore's bootstrap DDL vocabulary, without executing it.
export async function verifySqliteSchema(connection: SqlConnection, statements: readonly string[]) {
  const values: SqlValue[] = []
  const probes = statements.map((statement, position) => {
    const object = /^CREATE (?:VIRTUAL )?(TABLE|(?:UNIQUE )?INDEX|TRIGGER) IF NOT EXISTS ([a-z_][a-z0-9_]*)\b/.exec(
      statement,
    )
    if (!object) throw new StorageIntegrityError("Unsupported SQLite bootstrap schema statement")
    values.push(object[1]!.endsWith("INDEX") ? "index" : object[1]!.toLowerCase(), object[2]!)
    return `SELECT ${position} AS position WHERE NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?)`
  })
  if ((await connection.query(probes.join(" UNION ALL "), values)).length)
    throw new StorageIntegrityError("Existing SQLite schema requires an explicit storage upgrade")
}
