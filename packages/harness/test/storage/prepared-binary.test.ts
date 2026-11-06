import { afterAll, expect, test } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("prepared bytes survive collection and publish atomically with their record", () =>
  runtime.run(async () => {
    const key = ["prepared-test", crypto.randomUUID(), "bytes"]
    const record = [...key, "checkpoint"]
    await using prepared = await Storage.prepareBinary(key, new Uint8Array([1, 2, 3]))
    await expect(Storage.readBinary(key)).rejects.toBeInstanceOf(Storage.NotFoundError)
    await Storage.collectArtifactGarbage({ scanOrphans: true })
    await Storage.transaction(async () => {
      await Storage.publishPreparedBinary(prepared)
      await Storage.write(record, { bytes: 3 })
    })
    expect(await Storage.readBinary(key)).toEqual(new Uint8Array([1, 2, 3]))
    expect(await Storage.read<{ bytes: number }>(record)).toEqual({ bytes: 3 })
  }))

test("a failed publication preserves the previous bytes and checkpoint", () =>
  runtime.run(async () => {
    const key = ["prepared-test", crypto.randomUUID(), "bytes"]
    await Storage.writeBinary(key, new Uint8Array([1]))
    await using prepared = await Storage.prepareBinary(key, new Uint8Array([2]))
    await expect(
      Storage.transaction(async () => {
        await Storage.publishPreparedBinary(prepared)
        await Storage.write([...key, "checkpoint"], { bytes: 1 })
        throw new Error("rollback")
      }),
    ).rejects.toThrow("rollback")
    expect(await Storage.readBinary(key)).toEqual(new Uint8Array([1]))
    await expect(Storage.read([...key, "checkpoint"])).rejects.toBeInstanceOf(Storage.NotFoundError)
  }))

test("preparation and publication enforce the transaction boundary", () =>
  runtime.run(async () => {
    const key = ["prepared-test", crypto.randomUUID(), "bytes"]
    await using prepared = await Storage.prepareBinary(key, new Uint8Array([1]))
    await expect(Storage.publishPreparedBinary(prepared)).rejects.toThrow("transaction")
    await expect(Storage.transaction(() => Storage.prepareBinary(key, new Uint8Array([1])))).rejects.toThrow("flushed")
  }))
