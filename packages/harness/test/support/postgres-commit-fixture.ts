import { PostgresDriver } from "../../src/storage/postgres-driver"
import type { SqlConnection, SqlRow, SqlValue } from "../../src/storage/sql-contract"

export function postgresCommitFixture(
  connection: SqlConnection,
  shouldPause: (statement: string, values: SqlValue[]) => boolean,
) {
  const waiting = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let ownershipChecks = 0
  let hasStagedMutation = false
  const owner = async () => {
    if (++ownershipChecks === 2 && hasStagedMutation) {
      waiting.resolve()
      await released.promise
    }
    return [{ pid: 1, held: true }]
  }
  const statements: string[] = []
  const pool = {
    async reserve() {
      return {
        async unsafe(statement: string, values: SqlValue[]) {
          statements.push(statement)
          if (
            statement.startsWith("BEGIN ISOLATION LEVEL") ||
            statement === "SET LOCAL synchronous_commit = on" ||
            statement === "COMMIT" ||
            statement === "ROLLBACK"
          )
            return []
          const rows = await connection.query<SqlRow>(statement, values)
          if (shouldPause(statement, values)) hasStagedMutation = true
          return rows
        },
        async release() {},
      }
    },
  }
  const driver = Reflect.construct(PostgresDriver, [pool, owner, { pid: 1, classID: 1, objectID: 1 }]) as PostgresDriver
  return { driver, waiting, released, statements }
}
