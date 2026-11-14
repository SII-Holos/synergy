import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { AuthorityJournal as Journal } from "../../src/storage/authority-journal"
import { StorageCheckpoint } from "../../src/storage/checkpoint"
import { Storage } from "../../src/storage/storage"
import { StorageMutationGuard } from "../../src/storage/mutation-guard"
import { StoreTransaction, TransactionalStore } from "../../src/storage/transactional-store"
import { RuntimeContext } from "../../src/lifecycle/context"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

const Policy = z.strictObject({ enabled: z.boolean(), credential: z.string(), lastSeen: z.number() })
const actor = {
  kind: "system" as const,
  subjectID: "recovery-fixture",
  displayName: "Recovery fixture",
  clientKind: "cli" as const,
  requestID: "recovery-change",
}
const keys = {
  async current() {
    return { version: "fixture", key: Buffer.alloc(32, 17) }
  },
  async resolve() {
    return Buffer.alloc(32, 17)
  },
}
async function fixture() {
  const runtime = await storageTestRuntime()
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "journal-adoption-"))
  const store = await TransactionalStore.open(
    storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(directory, "db") }),
  )
  await runtime.run(() => {
    RuntimeContext.current().storage = { store, artifactDirectory: path.join(directory, "artifacts") }
    Journal.register({
      id: "policy",
      version: 1,
      prefixes: [["policy"]],
      project(_key, value) {
        const record = Policy.parse(value)
        return { enabled: record.enabled, credentialHash: createHash("sha256").update(record.credential).digest("hex") }
      },
    })
  })
  return {
    run: runtime.run,
    directory,
    store,
    async [Symbol.asyncDispose]() {
      await store.close()
      await runtime.close()
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}
async function archives(projectedChange = true) {
  const source = await fixture()
  const initial = await source.run(async () => {
    await Storage.write(["policy", "one"], { enabled: true, credential: "original-private", lastSeen: 1 })
    await Storage.write(["policy", "deleted"], { enabled: true, credential: "deleted-private", lastSeen: 1 })
    await Storage.write(["unprojected"], "original-unprojected")
    const head = await Journal.initialize({ namespaceID: "original-organization" })
    const directory = path.join(source.directory, "h0")
    const expected = await StorageCheckpoint.exportArchive({
      directory,
      archiveID: "h0",
      namespaceID: "original-organization",
      buildVersion: "fixture",
      keys,
      protect: () => true,
    })
    return { head, directory, expected }
  })
  const current = await source.run(async () => {
    if (!projectedChange)
      await Storage.write(["policy", "one"], { enabled: true, credential: "original-private", lastSeen: 99 })
    else
      await Journal.transaction("policy.current", async (journal) => {
        journal.identify(actor)
        await Storage.write(["policy", "one"], { enabled: false, credential: "current-private", lastSeen: 99 })
        await Storage.remove(["policy", "deleted"])
        await Storage.write(["policy", "new"], { enabled: true, credential: "new-private", lastSeen: 2 })
      })
    await Storage.write(["unprojected"], "later-unprojected")
    const head = await Journal.head()
    const directory = path.join(source.directory, "h1")
    const expected = await StorageCheckpoint.exportArchive({
      directory,
      archiveID: "h1",
      namespaceID: "original-organization",
      buildVersion: "fixture",
      keys,
      protect: () => true,
    })
    return { head, directory, expected }
  })
  return {
    source,
    initial,
    current,
    async [Symbol.asyncDispose]() {
      await source[Symbol.asyncDispose]()
    },
  }
}

test("adoption reconstructs complete current private facts and the actual continuation atomically", async () => {
  await using input = await archives()
  await using target = await fixture()
  await target.run(async () => {
    await StorageCheckpoint.restoreArchive({ ...input.initial, keys, restoreID: "initial", async finalize() {} })
    let escaped: Journal.Adoption | undefined
    await Journal.withAdoption({ ...input.current, keys, after: input.initial.head }, async (evidence) => {
      escaped = evidence
      expect(Journal.describeAdoption(evidence)).toEqual(input.current.head)
      await expect(Storage.snapshot((tx) => Journal.adopt(tx, evidence))).rejects.toThrow("write transaction")
      const rejected = new Error("final recovery guard refused")
      await expect(
        Storage.transaction(
          async (tx) => {
            await Journal.adopt(tx, evidence)
          },
          {
            commitGuard() {
              throw rejected
            },
          },
        ),
      ).rejects.toBe(rejected)
      expect(await Journal.head()).toEqual(input.initial.head)
      expect(await Storage.read(["policy", "one"])).toMatchObject({ credential: "original-private" })
      await Storage.transaction((tx) => Journal.adopt(tx, evidence))
      expect(await Journal.head()).toEqual(input.current.head)
      expect(await Storage.read(["policy", "one"])).toEqual({
        enabled: false,
        credential: "current-private",
        lastSeen: 99,
      })
      expect(await Storage.readMany([["policy", "deleted"]])).toEqual([undefined])
      expect(await Storage.read(["policy", "new"])).toMatchObject({ credential: "new-private" })
      expect(await Storage.read(["unprojected"])).toBe("original-unprojected")
      expect((await Journal.inspect()).covered).toBe(true)
      await Storage.transaction((tx) => Journal.adopt(tx, evidence))
    })
    await expect(Storage.transaction((tx) => Journal.adopt(tx, escaped!))).rejects.toThrow("callback")
  })
})

test("an unchanged authority head still reconstructs the complete canonical private record", async () => {
  await using input = await archives(false)
  await using target = await fixture()
  expect(input.current.head).toEqual(input.initial.head)
  await target.run(async () => {
    await StorageCheckpoint.restoreArchive({ ...input.initial, keys, restoreID: "initial", async finalize() {} })
    await Journal.withAdoption({ ...input.current, keys, after: input.initial.head }, (evidence) =>
      Storage.transaction((tx) => Journal.adopt(tx, evidence)),
    )
    expect(await Storage.read(["policy", "one"])).toMatchObject({ lastSeen: 99 })
  })
})

test("a swallowed late adoption failure cannot commit partial current policy", async () => {
  await using input = await archives()
  await using target = await fixture()
  await target.run(async () => {
    await StorageCheckpoint.restoreArchive({ ...input.initial, keys, restoreID: "initial", async finalize() {} })
    const failure = new Error("actual last authority head write failed")
    const write = StoreTransaction.prototype.write
    let failed = false
    using barrier = spyOn(StoreTransaction.prototype, "write").mockImplementation(async function (
      this: StoreTransaction,
      key,
      value,
    ) {
      if (
        !failed &&
        this.namespace === target.store.options.namespace &&
        JSON.stringify(key) === '["storage_authority_journal","head"]'
      ) {
        failed = true
        throw failure
      }
      return write.call(this, key, value)
    })
    await Journal.withAdoption({ ...input.current, keys, after: input.initial.head }, async (evidence) => {
      await expect(
        Storage.transaction(async (tx) => {
          await Journal.adopt(tx, evidence).catch(() => undefined)
          await Storage.write(["recovery", "receipt"], true)
        }),
      ).rejects.toBe(failure)
    })
    expect(failed).toBe(true)
    expect(await Journal.head()).toEqual(input.initial.head)
    expect(await Storage.read(["policy", "one"])).toMatchObject({ credential: "original-private" })
    expect(await Storage.readMany([["recovery", "receipt"]])).toEqual([undefined])
  })
})

test("an escaped same-key observer continuation cannot borrow an expired adoption mutation", async () => {
  await using input = await archives()
  await using target = await fixture()
  await target.run(async () => {
    await StorageCheckpoint.restoreArchive({ ...input.initial, keys, restoreID: "initial", async finalize() {} })
    const release = Promise.withResolvers<void>()
    let late: Promise<unknown> | undefined
    StorageMutationGuard.register("deferred-native-observer", async (_tx, keys) => {
      if (late || !keys.some((key) => JSON.stringify(key) === '["policy","one"]')) return
      late = (async () => {
        await release.promise
        await Storage.write(["policy", "one"], { enabled: true, credential: "late-uncovered", lastSeen: 3 })
      })().then(
        () => undefined,
        (error) => error,
      )
    })
    await Journal.withAdoption({ ...input.current, keys, after: input.initial.head }, async (evidence) => {
      let result: unknown
      await Storage.transaction(async (tx) => {
        await Journal.adopt(tx, evidence)
        release.resolve()
        result = await late
      })
      expect(result).toBeInstanceOf(Error)
      expect(await Storage.read(["policy", "one"])).toMatchObject({ credential: "current-private" })
      expect((await Journal.inspect()).covered).toBe(true)
    })
  })
})

test("adoption refuses an already accepted policy writer before sealing its actual transaction", async () => {
  await using input = await archives()
  await using target = await fixture()
  await target.run(async () => {
    await StorageCheckpoint.restoreArchive({ ...input.initial, keys, restoreID: "initial", async finalize() {} })
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    let held = false
    StorageMutationGuard.register("earlier-native-observer", async (_tx, keys) => {
      if (held || !keys.some((key) => JSON.stringify(key) === '["policy","one"]')) return
      held = true
      entered.resolve()
      await release.promise
    })
    await Journal.withAdoption({ ...input.current, keys, after: input.initial.head }, async (evidence) => {
      await expect(
        Storage.transaction(async (tx) => {
          const prior = Storage.write(["policy", "one"], { enabled: true, credential: "late-prior", lastSeen: 3 })
          await entered.promise
          await Journal.adopt(tx, evidence).catch(() => undefined)
          release.resolve()
          await prior
        }),
      ).rejects.toThrow("prior authority mutation")
      expect(await Journal.head()).toEqual(input.initial.head)
      expect(await Storage.read(["policy", "one"])).toMatchObject({ credential: "original-private" })
    })
  })
})

test("one native mutation permit cannot authorize a second accepted same-key writer", async () => {
  await using input = await archives()
  await using target = await fixture()
  await target.run(async () => {
    await StorageCheckpoint.restoreArchive({ ...input.initial, keys, restoreID: "initial", async finalize() {} })
    const release = Promise.withResolvers<void>()
    let late: Promise<unknown> | undefined
    let visits = 0
    StorageMutationGuard.register("spawn-native-observer", async (_tx, keys) => {
      if (late || !keys.some((key) => JSON.stringify(key) === '["policy","one"]')) return
      late = Storage.write(["policy", "one"], { enabled: true, credential: "late-second", lastSeen: 4 }).then(
        () => undefined,
        (error) => error,
      )
    })
    StorageMutationGuard.register("hold-second-observer", async (_tx, keys) => {
      if (keys.some((key) => JSON.stringify(key) === '["policy","one"]') && ++visits === 2) await release.promise
    })
    await Journal.withAdoption({ ...input.current, keys, after: input.initial.head }, async (evidence) => {
      let result: unknown
      await Storage.transaction(async (tx) => {
        await Journal.adopt(tx, evidence)
        release.resolve()
        result = await late
      })
      expect(result).toBeInstanceOf(Error)
      expect(await Storage.read(["policy", "one"])).toMatchObject({ credential: "current-private" })
      expect((await Journal.inspect()).covered).toBe(true)
    })
  })
})

test("the original adoption callback must survive its actual outer transaction commit", async () => {
  await using input = await archives()
  await using target = await fixture()
  await target.run(async () => {
    await StorageCheckpoint.restoreArchive({ ...input.initial, keys, restoreID: "initial", async finalize() {} })
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const write = StoreTransaction.prototype.write
    using barrier = spyOn(StoreTransaction.prototype, "write").mockImplementation(async function (
      this: StoreTransaction,
      key,
      value,
    ) {
      if (this.namespace === target.store.options.namespace && JSON.stringify(key) === '["recovery","later"]') {
        entered.resolve()
        await release.promise
      }
      return write.call(this, key, value)
    })
    let work: Promise<unknown> | undefined
    await Journal.withAdoption({ ...input.current, keys, after: input.initial.head }, async (evidence) => {
      work = Storage.transaction(async (tx) => {
        await Journal.adopt(tx, evidence)
        await tx.write(["recovery", "later"], true)
      }).then(
        () => undefined,
        (error) => error,
      )
      await entered.promise
    })
    release.resolve()
    const error = await work
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain("callback")
    expect(await Journal.head()).toEqual(input.initial.head)
    expect(await Storage.read(["policy", "one"])).toMatchObject({ credential: "original-private" })
    expect(await Storage.readMany([["recovery", "later"]])).toEqual([undefined])
  })
})

test("cancellation after the real head write rolls back policy and history together", async () => {
  await using input = await archives()
  await using target = await fixture()
  await target.run(async () => {
    await StorageCheckpoint.restoreArchive({ ...input.initial, keys, restoreID: "initial", async finalize() {} })
    const controller = new AbortController(),
      reason = new Error("original adoption cancelled after actual write")
    const write = StoreTransaction.prototype.write
    using barrier = spyOn(StoreTransaction.prototype, "write").mockImplementation(async function (
      this: StoreTransaction,
      key,
      value,
    ) {
      await write.call(this, key, value)
      if (
        this.namespace === target.store.options.namespace &&
        JSON.stringify(key) === '["storage_authority_journal","head"]'
      )
        controller.abort(reason)
    })
    await expect(
      Journal.withAdoption(
        { ...input.current, keys, after: input.initial.head, signal: controller.signal },
        (evidence) => Storage.transaction((tx) => Journal.adopt(tx, evidence)),
      ),
    ).rejects.toBe(reason)
    expect(await Journal.head()).toEqual(input.initial.head)
    expect(await Storage.read(["policy", "one"])).toMatchObject({ credential: "original-private" })
    expect((await Journal.inspect()).covered).toBe(true)
  })
})

test("adoption rejects foreign Runtime evidence, changed primary configuration and pre-cancelled reads", async () => {
  await using input = await archives()
  await using target = await fixture()
  await using foreign = await fixture()
  await target.run(async () => {
    await StorageCheckpoint.restoreArchive({ ...input.initial, keys, restoreID: "initial", async finalize() {} })
    await Journal.withAdoption({ ...input.current, keys, after: input.initial.head }, async (evidence) => {
      await expect(foreign.run(() => Storage.transaction((tx) => Journal.adopt(tx, evidence)))).rejects.toThrow(
        "another Runtime",
      )
      const original = target.store.options.namespace
      try {
        Object.assign(target.store.options, { namespace: "foreign-configuration" })
        expect(() => Journal.describeAdoption(evidence)).toThrow("primary Store")
      } finally {
        Object.assign(target.store.options, { namespace: original })
      }
    })
    const controller = new AbortController(),
      reason = new Error("adoption pre-cancelled")
    controller.abort(reason)
    let reads = 0
    await expect(
      Journal.withAdoption(
        {
          ...input.current,
          keys: {
            current: keys.current,
            async resolve() {
              reads++
              return Buffer.alloc(32, 17)
            },
          },
          after: input.initial.head,
          signal: controller.signal,
        },
        async () => {},
      ),
    ).rejects.toBe(reason)
    expect(reads).toBe(0)
    expect(await Journal.head()).toEqual(input.initial.head)
  })
})
