import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { SqliteWorkerClient } from "../../src/storage/sqlite-worker-client"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test.skipIf(process.platform === "win32")("reads complete while the owned writer process is suspended", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const driver = await SqliteDriver.open(path.join(tmp.path, "agent.sqlite"))
    const writer = (driver as unknown as { writer: { worker: Bun.Subprocess } }).writer.worker
    let rescued = false
    process.kill(writer.pid, "SIGSTOP")
    const rescue = setTimeout(() => {
      rescued = true
      process.kill(writer.pid, "SIGCONT")
    }, 5_000)
    try {
      expect(await driver.query("SELECT 7 AS value")).toEqual([{ value: 7n }])
      expect(rescued).toBe(false)
    } finally {
      clearTimeout(rescue)
      process.kill(writer.pid, "SIGCONT")
      await driver.close()
    }
  }),
)

test("a failed reader is replaced without invalidating writes or a different store", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const first = await SqliteDriver.open(path.join(tmp.path, "first.sqlite"))
    const second = await SqliteDriver.open(path.join(tmp.path, "second.sqlite"))
    const reader = (first as unknown as { reader: SqliteWorkerClient }).reader
    try {
      const process = (reader as unknown as { worker: Bun.Subprocess }).worker
      process.kill()
      await process.exited
      expect(await first.query("SELECT 9 AS value")).toEqual([{ value: 9n }])
      expect(await first.transaction((tx) => tx.query("SELECT 8 AS value"))).toEqual([{ value: 8n }])
      expect(await second.query("SELECT 7 AS value")).toEqual([{ value: 7n }])
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  }))

test("reader snapshots stay consistent while writes commit and cannot mutate storage", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const driver = await SqliteDriver.open(path.join(tmp.path, "agent.sqlite"))
    try {
      await driver.transaction(async (tx) => {
        await tx.query("CREATE TABLE values_for_test(value INTEGER)")
        await tx.query("INSERT INTO values_for_test VALUES (1)")
        expect(await tx.query("SELECT value FROM values_for_test")).toEqual([{ value: 1n }])
      })
      await driver.transaction(
        async (reader) => {
          expect(await reader.query("SELECT value FROM values_for_test")).toEqual([{ value: 1n }])
          await driver.transaction((writer) => writer.query("UPDATE values_for_test SET value = 2"))
          expect(await reader.query("SELECT value FROM values_for_test")).toEqual([{ value: 1n }])
        },
        { readOnly: true },
      )
      expect(await driver.query("SELECT value FROM values_for_test")).toEqual([{ value: 2n }])
      await expect(driver.query("DELETE FROM values_for_test")).rejects.toThrow()
      expect(await driver.query("SELECT value FROM values_for_test")).toEqual([{ value: 2n }])
    } finally {
      await driver.close()
    }
  }))
