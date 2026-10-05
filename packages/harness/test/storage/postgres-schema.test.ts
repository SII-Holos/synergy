import { expect, test } from "bun:test"
import { PostgresDriver } from "../../src/storage/postgres-driver"
import { storageTestBackends } from "../support/storage-backends"

const postgresTest = test.skipIf(!storageTestBackends().includes("postgres"))

postgresTest(
  "concurrent PostgreSQL bootstrap and missing-object repair preserve records",
  async () => {
    const name = "schema_test_" + crypto.randomUUID().replaceAll("-", "")
    const drivers: PostgresDriver[] = []
    const schema = [
      `CREATE TABLE IF NOT EXISTS ${name} (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS ${name}_value ON ${name}(value)`,
      `CREATE OR REPLACE FUNCTION ${name}_normalize() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.value := upper(NEW.value); RETURN NEW; END $$`,
      `CREATE OR REPLACE TRIGGER ${name}_insert BEFORE INSERT ON ${name} FOR EACH ROW EXECUTE FUNCTION ${name}_normalize()`,
    ]
    try {
      for (let owner = 0; owner < 8; owner++)
        drivers.push(await PostgresDriver.open(process.env.SYNERGY_TEST_POSTGRES_URL!, crypto.randomUUID(), 3))
      await Promise.all(drivers.map((driver) => driver.initializeSchema(schema)))
      const driver = drivers[0]!
      await driver.transaction(async (connection) => {
        await connection.query(`INSERT INTO ${name} VALUES (1, 'retained')`)
      })
      await driver.query(`DROP INDEX ${name}_value`)
      await driver.query(`DROP TRIGGER ${name}_insert ON ${name}`)
      await driver.query(`DROP FUNCTION ${name}_normalize()`)
      await Promise.all(drivers.map((current) => current.initializeSchema(schema)))
      await driver.query(`INSERT INTO ${name} VALUES (2, 'restored')`)
      expect(await driver.query(`SELECT * FROM ${name} ORDER BY id`)).toEqual([
        { id: 1, value: "RETAINED" },
        { id: 2, value: "RESTORED" },
      ])
      expect((await driver.query("SELECT to_regclass(?)::text AS name", [name + "_value"]))[0]?.name).toBe(
        name + "_value",
      )
    } finally {
      await drivers[0]?.query(`DROP TABLE IF EXISTS ${name}`)
      await drivers[0]?.query(`DROP FUNCTION IF EXISTS ${name}_normalize()`)
      await Promise.all(drivers.map((driver) => driver.close()))
    }
  },
  30_000,
)

postgresTest("failed PostgreSQL bootstrap rolls back its objects and releases initialization ownership", async () => {
  const name = "schema_test_" + crypto.randomUUID().replaceAll("-", "")
  const driver = await PostgresDriver.open(process.env.SYNERGY_TEST_POSTGRES_URL!, crypto.randomUUID(), 3)
  try {
    await expect(
      driver.initializeSchema([
        `CREATE TABLE IF NOT EXISTS ${name} (value TEXT)`,
        `CREATE TABLE IF NOT EXISTS ${name}_invalid (value synergy_nonexistent_test_type)`,
      ]),
    ).rejects.toThrow()
    expect((await driver.query("SELECT to_regclass(?)::text AS name", [name]))[0]?.name).toBeNull()
    const replacement = await PostgresDriver.open(process.env.SYNERGY_TEST_POSTGRES_URL!, crypto.randomUUID(), 3)
    try {
      await replacement.initializeSchema([`CREATE TABLE IF NOT EXISTS ${name} (value TEXT)`])
      await replacement.query(`INSERT INTO ${name} VALUES ('recovered')`)
      expect(await replacement.query(`SELECT value FROM ${name}`)).toEqual([{ value: "recovered" }])
    } finally {
      await replacement.close()
    }
  } finally {
    await driver.query(`DROP TABLE IF EXISTS ${name}`)
    await driver.close()
  }
})
