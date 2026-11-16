import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestRuntime } from "../support/storage-runtime"

async function check(lease: RuntimeMaintenance.Lease, receipt: RuntimeMaintenance.DrainReceipt) {
  const inspect: unknown = Reflect.get(RuntimeMaintenance, "assertDrained")
  if (typeof inspect === "function") return inspect(lease, receipt)
  return RuntimeMaintenance.assertDraining(lease)
}

async function fixture() {
  const runtime = await storageTestRuntime()
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "drained-receipt-"))
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: crypto.randomUUID(),
    filename: path.join(directory, "db"),
  })
  const handle = { store, artifactDirectory: path.join(directory, "content") }
  const run = <T>(body: () => T | Promise<T>) => runtime.run(() => Storage.provide(handle, body))
  let drains = 0
  await run(() => {
    RuntimeMaintenance.configure({ required: ["original-writer"] })
    RuntimeMaintenance.register("original-writer", {
      version: 1,
      async suspend(context) {
        await RuntimeMaintenance.assertDraining(context.lease)
      },
      async drain(context) {
        await RuntimeMaintenance.assertDraining(context.lease)
        drains++
      },
      async inspect() {
        return []
      },
      async release(context) {
        await RuntimeMaintenance.assertReleasing(context.lease)
      },
    })
  })
  return {
    run,
    store,
    handle,
    drains: () => drains,
    async [Symbol.asyncDispose]() {
      try {
        await store.close()
      } finally {
        await runtime.close()
        await fs.rm(directory, { recursive: true, force: true })
      }
    },
  }
}
async function begin() {
  const requestID = crypto.randomUUID()
  return RuntimeMaintenance.begin({
    purpose: "organization-backup",
    requestID,
    actor: {
      kind: "system",
      subjectID: "original-native-operator",
      displayName: "Host operator",
      clientKind: "system",
      requestID,
    },
  })
}

test("native drainage inspection is read-only and requires the original receipt in its actual live writer", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const lease = await begin()
    const receipt = await RuntimeMaintenance.drain(lease)
    expect(f.drains()).toBe(1)
    const before = await RuntimeMaintenance.status()
    expect(await Storage.transaction(() => check(lease, receipt))).toEqual(before)
    expect(await RuntimeMaintenance.status()).toEqual(before)
    await expect(Storage.transaction(() => check(lease, { ...receipt }))).rejects.toThrow()
    await expect(Storage.transaction(() => check({ ...lease }, receipt))).rejects.toThrow()
    await expect(check(lease, receipt)).rejects.toThrow("live write callback")
    await expect(Storage.snapshot(() => check(lease, receipt))).rejects.toThrow("live write callback")
    await expect(f.store.transaction(() => check(lease, receipt))).rejects.toThrow("live write callback")
    const release = Promise.withResolvers<void>()
    let escaped: Promise<unknown> | undefined
    await Storage.transaction(async () => {
      escaped = release.promise.then(() => check(lease, receipt))
    })
    const observed = escaped!.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    release.resolve()
    expect(await observed).toMatchObject({ error: expect.any(Error) })
    expect(await RuntimeMaintenance.status()).toEqual(before)
    await RuntimeMaintenance.release(lease)
  })
})

test("native drainage inspection rejects changed tails, frozen and released phases without bypassing mutation guards", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const lease = await begin()
    const initial = await RuntimeMaintenance.drain(lease)
    const before = await RuntimeMaintenance.status()
    await Storage.write(["actual-native-tail"], { revision: 1 })
    expect((await RuntimeMaintenance.status())!.tailRevision).toBe(before!.tailRevision + 1)
    await expect(Storage.transaction(() => check(lease, initial))).rejects.toThrow("draining tail")
    const current = await RuntimeMaintenance.drain(lease)
    await Storage.transaction(async () => {
      await check(lease, current)
      await Storage.write(["derived-original-repair"], { retained: true })
    })
    await expect(Storage.transaction(() => check(lease, current))).rejects.toThrow("draining tail")
    expect(await Storage.read(["derived-original-repair"])).toEqual({ retained: true })
    const final = await RuntimeMaintenance.drain(lease)
    await RuntimeMaintenance.freeze(lease, final)
    await expect(Storage.transaction(() => check(lease, final))).rejects.toThrow("draining tail")
    await expect(Storage.write(["frozen-ordinary-write"], true)).rejects.toThrow("freezes ordinary")
    expect(await Storage.readMany([["frozen-ordinary-write"]])).toEqual([undefined])
    await RuntimeMaintenance.release(lease)
    await expect(Storage.transaction(() => check(lease, final))).rejects.toThrow("draining tail")
  })
})

test("native drainage inspection rejects another original Runtime, Store and actual receipt", async () => {
  await using first = await fixture()
  await using second = await fixture()
  const original = await first.run(async () => {
    const lease = await begin()
    return { lease, receipt: await RuntimeMaintenance.drain(lease) }
  })
  const foreign = await second.run(async () => {
    const lease = await begin()
    return { lease, receipt: await RuntimeMaintenance.drain(lease) }
  })
  await second.run(() => expect(Storage.transaction(() => check(original.lease, original.receipt))).rejects.toThrow())
  await first.run(async () => {
    await expect(Storage.transaction(() => check(original.lease, foreign.receipt))).rejects.toThrow(
      "actual owner drainage",
    )
    await expect(
      Storage.provide(second.handle, () => Storage.transaction(() => check(original.lease, original.receipt))),
    ).rejects.toThrow("another Runtime or namespace")
    await RuntimeMaintenance.release(original.lease)
  })
  await second.run(() => RuntimeMaintenance.release(foreign.lease))
})
