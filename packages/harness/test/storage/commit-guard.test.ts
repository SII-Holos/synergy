import { expect, test } from "bun:test"
import path from "node:path"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { postgresCommitFixture } from "../support/postgres-commit-fixture"

test("SQLite checks authority at its commit decision and rolls back staged records", async () => {
  await using directory = await tmpdir()
  const driver = await SqliteDriver.open(path.join(directory.path, "commit.sqlite"))
  try {
    await driver.transaction((connection) =>
      connection.query("CREATE TABLE grants (name TEXT PRIMARY KEY, phase TEXT)"),
    )
    await expect(
      driver.transaction(
        async (connection) => {
          await connection.query("INSERT INTO grants VALUES (?, ?)", ["peer", "approved"])
        },
        {
          commitGuard() {
            throw new Error("authority withdrawn before COMMIT")
          },
        },
      ),
    ).rejects.toThrow("authority withdrawn before COMMIT")
    expect(await driver.query("SELECT * FROM grants")).toEqual([])
    await driver.transaction(
      async (connection) => {
        await connection.query("INSERT INTO grants VALUES (?, ?)", ["peer", "approved"])
      },
      { commitGuard() {} },
    )
    expect(await driver.query("SELECT * FROM grants")).toEqual([{ name: "peer", phase: "approved" }])
  } finally {
    await driver.close()
  }
}, 30_000)

test("PostgreSQL driver checks authority after its post-body ownership await (SQL transport fixture)", async () => {
  await using directory = await tmpdir()
  const sqlite = await SqliteDriver.open(path.join(directory.path, "postgres-transport.sqlite"))
  try {
    await sqlite.transaction((connection) =>
      connection.query("CREATE TABLE grants (name TEXT PRIMARY KEY, phase TEXT)"),
    )
    const controller = new AbortController()
    let fixture: ReturnType<typeof postgresCommitFixture> | undefined
    const reached = Promise.withResolvers<ReturnType<typeof postgresCommitFixture>>()
    const pending = sqlite.transaction(async (connection) => {
      fixture = postgresCommitFixture(connection, (statement) => statement.startsWith("INSERT INTO grants"))
      reached.resolve(fixture)
      return fixture.driver.transaction(
        async (postgres) => {
          await postgres.query("INSERT INTO grants VALUES (?, ?)", ["peer", "approved"])
        },
        { commitGuard: () => controller.signal.throwIfAborted() },
      )
    })
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      const barrier = await Promise.race([
        reached.promise,
        settled.then((error) => {
          throw error
        }),
      ])
      await Promise.race([
        barrier.waiting.promise,
        settled.then((error) => {
          throw error
        }),
      ])
      controller.abort(new Error("authority withdrawn during ownership query"))
      barrier.released.resolve()
      expect(await settled).toBeInstanceOf(Error)
      expect(barrier.statements).not.toContain("COMMIT")
      expect(barrier.statements).toContain("ROLLBACK")
      expect(await sqlite.query("SELECT * FROM grants")).toEqual([])
    } finally {
      fixture?.released.resolve()
      await settled
    }
  } finally {
    await sqlite.close()
  }
}, 30_000)

test("nested Storage commit guards survive until the ambient transaction commits", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await Storage.write(["commit-guard", "retained"], { phase: "pending" })
    const controller = new AbortController()
    await expect(
      Storage.transaction(async () => {
        await Storage.transaction(
          async () => {
            await Storage.write(["commit-guard", "retained"], { phase: "approved" })
          },
          { commitGuard: () => controller.signal.throwIfAborted() },
        )
        await Storage.write(["commit-guard", "peer"], { approved: true })
        controller.abort(new Error("nested authority withdrawn"))
      }),
    ).rejects.toThrow("nested authority withdrawn")
    expect(await Storage.read<{ phase: string }>(["commit-guard", "retained"])).toEqual({ phase: "pending" })
    await expect(Storage.read(["commit-guard", "peer"])).rejects.toBeInstanceOf(Storage.NotFoundError)
    let assertions = 0
    await Storage.transaction(
      async () => {
        await Storage.transaction(
          async () => {
            await Storage.write(["commit-guard", "retained"], { phase: "approved" })
          },
          {
            commitGuard() {
              assertions++
            },
          },
        )
      },
      {
        commitGuard() {
          assertions++
        },
      },
    )
    expect(assertions).toBe(2)
    expect(await Storage.read<{ phase: string }>(["commit-guard", "retained"])).toEqual({ phase: "approved" })
    await expect(
      Storage.snapshot(() =>
        Storage.transaction(async () => undefined, {
          commitGuard() {},
        }),
      ),
    ).rejects.toThrow("write transaction")
  })
}, 30_000)

test("Storage retries discard commit guards from rolled-back attempts", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    let attempts = 0
    let guardCalls = 0
    await Storage.transaction(async () => {
      const attempt = ++attempts
      await Storage.transaction(
        async () => {
          await Storage.write(["commit-retry", String(attempt)], { attempt })
        },
        {
          commitGuard() {
            if (attempt === 1) throw new Error("rolled-back guard must not survive retry")
            guardCalls++
          },
        },
      )
      if (attempt === 1) throw Object.assign(new Error("retry transaction"), { code: "SQLITE_BUSY" })
    })
    expect(attempts).toBe(2)
    expect(guardCalls).toBe(1)
    expect(
      await Storage.readMany([
        ["commit-retry", "1"],
        ["commit-retry", "2"],
      ]),
    ).toEqual([undefined, { attempt: 2 }])
  })
}, 30_000)

test("Storage receipt replay retains the outer commit guard without rerunning nested mutations", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    let mutations = 0
    let outerGuards = 0
    let nestedGuards = 0
    const execute = () =>
      Storage.transaction(
        async () => {
          mutations++
          await Storage.transaction(() => Storage.write(["commit-receipt"], { approved: true }), {
            commitGuard() {
              nestedGuards++
            },
          })
          return { approved: true }
        },
        {
          operationID: "commit-receipt",
          requestHash: "same-approval",
          commitGuard() {
            outerGuards++
          },
        },
      )
    expect(await execute()).toEqual({ approved: true })
    expect(await execute()).toEqual({ approved: true })
    expect(mutations).toBe(1)
    expect(outerGuards).toBe(2)
    expect(nestedGuards).toBe(1)
    expect(await Storage.read<{ approved: boolean }>(["commit-receipt"])).toEqual({ approved: true })
  })
}, 30_000)
