import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { MaintenanceRetirementRecords } from "../../src/storage/maintenance-retirement-records"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore, StoreTransaction, type TransactionOptions } from "../../src/storage/transactional-store"
import { StorageCommitUnknownError } from "../../src/storage/errors"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

async function fixture() {
  let runtime = await storageTestRuntime()
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "runtime-maintenance-"))
  const store = await TransactionalStore.open(
    storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "db") }),
  )
  const run = <T>(body: () => T | Promise<T>) =>
    runtime.run(() => Storage.provide({ store, artifactDirectory: path.join(root, "content") }, body))
  return {
    run,
    store,
    async restart() {
      await runtime.close()
      runtime = await storageTestRuntime()
    },
    async [Symbol.asyncDispose]() {
      await store.close()
      await runtime.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
const actor = {
  kind: "system" as const,
  subjectID: "host-operator",
  displayName: "Host operator",
  clientKind: "system" as const,
  requestID: "maintenance-one",
}

test("a frozen native owner operation retains its phase until actual protected work finishes before releasing", async () => {
  await using f = await fixture()
  await f.run(async () => {
    let releases = 0
    RuntimeMaintenance.configure({ required: ["writer"] })
    RuntimeMaintenance.register("writer", {
      version: 1,
      async suspend() {},
      async drain() {},
      async inspect() {
        return []
      },
      async release() {
        releases++
      },
    })
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const captured = RuntimeMaintenance.withFrozen(lease, async () => {
      entered.resolve()
      await finish.promise
      expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
      return "retained"
    })
    await entered.promise
    const released = RuntimeMaintenance.release(lease)
    try {
      await expect(Storage.write(["canonical", "while-capturing"], { unsafe: true })).rejects.toThrow()
      expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
      expect(releases).toBe(0)
    } finally {
      finish.resolve()
      expect(await captured).toBe("retained")
      await released
    }
    expect(releases).toBe(1)
    expect((await RuntimeMaintenance.status())?.phase).toBe("released")
    let invoked = false
    await expect(
      RuntimeMaintenance.withFrozen({ ...lease }, async () => {
        invoked = true
      }),
    ).rejects.toThrow()
    expect(invoked).toBeFalse()
  })
})

test("native owner release validates the actual opaque lease and releasing phase", async () => {
  await using f = await fixture()
  await f.run(async () => {
    let releases = 0
    RuntimeMaintenance.configure({ required: ["writer"] })
    RuntimeMaintenance.register("writer", {
      version: 1,
      async suspend() {},
      async drain() {},
      async inspect() {
        return []
      },
      async release(context) {
        const info = await RuntimeMaintenance.assertReleasing(context.lease)
        expect(info.maintenanceID).toBe(context.maintenanceID)
        await expect(RuntimeMaintenance.assertReleasing({ ...context.lease })).rejects.toThrow()
        releases++
      },
    })
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    await expect(RuntimeMaintenance.assertReleasing(lease)).rejects.toThrow()
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    await expect(RuntimeMaintenance.assertReleasing(lease)).rejects.toThrow()
    await RuntimeMaintenance.release(lease)
    expect(releases).toBe(1)
    await expect(RuntimeMaintenance.assertReleasing(lease)).rejects.toThrow()
  })
})

test("an immutable retirement reservation permanently retains its original frozen source operation", async () => {
  await using f = await fixture()
  const frozen = await f.run(async () => {
    let released = 0
    RuntimeMaintenance.configure({ required: ["writer"] })
    RuntimeMaintenance.register("writer", {
      version: 1,
      async suspend() {},
      async drain() {},
      async inspect() {
        return []
      },
      async release() {
        released++
      },
    })
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    const frozen = await RuntimeMaintenance.status()
    if (!frozen) throw new Error("Frozen source operation is absent")
    const referenceHash = "a".repeat(64)
    const transaction = f.store.transaction.bind(f.store)
    const unknown = new StorageCommitUnknownError("source-retirement", new Error("Retirement acknowledgement lost"))
    let lost = false
    using fault = spyOn(f.store, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
        const result = await transaction(body, options)
        if (!lost && MaintenanceRetirementRecords.Info.safeParse(result).success) {
          lost = true
          throw unknown
        }
        return result
      },
    )
    await expect(RuntimeMaintenance.reserveRetirement(lease, referenceHash)).rejects.toThrow("callback")
    await RuntimeMaintenance.withFrozen(lease, async () => {
      await expect(RuntimeMaintenance.reserveRetirement({ ...lease }, referenceHash)).rejects.toThrow()
      await expect(RuntimeMaintenance.reserveRetirement(lease, referenceHash)).rejects.toBe(unknown)
      const record = await RuntimeMaintenance.retirement(lease.maintenanceID)
      if (!record) throw new Error("Committed source retirement reservation is absent")
      expect(record.source).toEqual(frozen)
      expect(record.referenceHash).toBe(referenceHash)
      expect(await RuntimeMaintenance.reserveRetirement(lease, referenceHash)).toEqual(record)
      await expect(RuntimeMaintenance.reserveRetirement(lease, "b".repeat(64))).rejects.toThrow("another")
    })
    expect(await RuntimeMaintenance.status()).toEqual(frozen)
    await expect(RuntimeMaintenance.release(lease)).rejects.toThrow("retirement")
    expect(released).toBe(0)
    await expect(Storage.write(["canonical", "retired-source"], { resumed: true })).rejects.toThrow()
    expect((await RuntimeMaintenance.retirement(lease.maintenanceID))?.referenceHash).toBe(referenceHash)
    return frozen
  })
  await f.restart()
  await f.run(async () => {
    RuntimeMaintenance.registerProtection()
    await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
    expect((await RuntimeMaintenance.retirement(frozen.maintenanceID))?.source).toEqual(frozen)
    await f.store.remove(["runtime_maintenance", "current"])
    await f.store.removeTree(["runtime_maintenance", "operations"])
    await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow("current operation pointer")
    expect((await RuntimeMaintenance.retirement(frozen.maintenanceID))?.source).toEqual(frozen)
  })
})

test("cancelling a source reservation after its actual write rolls back the permanent hold", async () => {
  await using f = await fixture()
  await f.run(async () => {
    RuntimeMaintenance.configure({ required: ["writer"] })
    RuntimeMaintenance.register("writer", {
      version: 1,
      async suspend() {},
      async drain() {},
      async inspect() {
        return []
      },
      async release() {},
    })
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    const controller = new AbortController()
    const reason = new Error("Source retirement cancelled at final write")
    const write = StoreTransaction.prototype.write
    using barrier = spyOn(StoreTransaction.prototype, "write").mockImplementation(async function (
      this: StoreTransaction,
      key,
      value,
    ) {
      const result = await write.call(this, key, value)
      if (key[0] === "runtime_maintenance" && key[1] === "retirements") controller.abort(reason)
      return result
    })
    await expect(
      RuntimeMaintenance.withFrozen(lease, () => RuntimeMaintenance.reserveRetirement(lease, "a".repeat(64)), {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason)
    expect(await RuntimeMaintenance.retirement(lease.maintenanceID)).toBeUndefined()
    expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
    await RuntimeMaintenance.release(lease)
    await RuntimeMaintenance.assertAdmission()
  })
})

test("native maintenance stops new admission, drains a real trailing writer and freezes ordinary canonical changes", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const stop = Promise.withResolvers<void>()
    let finished = false
    const tail = (async () => {
      await stop.promise
      await Storage.write(["canonical", "tail"], { retained: true })
      finished = true
    })()
    RuntimeMaintenance.configure({ required: ["writer"] })
    RuntimeMaintenance.register("writer", {
      version: 1,
      async suspend() {
        stop.resolve()
      },
      async drain() {
        await tail
      },
      async inspect() {
        return finished
          ? []
          : [{ code: "writer_running", owner: "writer", label: "Writer is still running", recoverable: true }]
      },
      async release() {},
    })
    await RuntimeMaintenance.assertAdmission()
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
    const receipt = await RuntimeMaintenance.drain(lease)
    expect(await Storage.read(["canonical", "tail"])).toEqual({ retained: true })
    await RuntimeMaintenance.freeze(lease, receipt)
    await expect(Storage.write(["canonical", "late"], { unsafe: true })).rejects.toThrow()
    await expect(Storage.removeTree(["canonical"])).rejects.toThrow()
    expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
    await RuntimeMaintenance.release(lease)
    await RuntimeMaintenance.assertAdmission()
    await Storage.write(["canonical", "after"], { allowed: true })
    expect((await RuntimeMaintenance.status())?.phase).toBe("released")
  })
})

test("a changed writer revision, forged receipt or foreign Runtime cannot freeze or release another maintenance hold", async () => {
  await using f = await fixture()
  await using other = await fixture()
  const hold = await f.run(async () => {
    RuntimeMaintenance.configure({ required: ["writer"] })
    RuntimeMaintenance.register("writer", {
      version: 1,
      async suspend() {},
      async drain() {},
      async inspect() {
        return []
      },
      async release() {},
    })
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    const receipt = await RuntimeMaintenance.drain(lease)
    await Storage.write(["canonical", "after-drain"], { intervening: true })
    await expect(RuntimeMaintenance.freeze(lease, receipt)).rejects.toThrow()
    await expect(RuntimeMaintenance.freeze(lease, { ...receipt })).rejects.toThrow()
    const current = await RuntimeMaintenance.drain(lease)
    await expect(
      Storage.transaction(async () => {
        await Storage.write(["canonical", "rolled-back"], { temporary: true })
        throw new Error("Fixture trailing writer rolled back")
      }),
    ).rejects.toThrow("rolled back")
    return { lease, receipt: current }
  })
  await other.run(async () => {
    await expect(RuntimeMaintenance.freeze(hold.lease, hold.receipt)).rejects.toThrow()
    await expect(RuntimeMaintenance.release(hold.lease)).rejects.toThrow()
  })
  await f.run(async () => {
    await RuntimeMaintenance.freeze(hold.lease, hold.receipt)
    await expect(Storage.write(["runtime_maintenance", "current"], { maintenanceID: "forged" })).rejects.toThrow()
    await RuntimeMaintenance.release(hold.lease)
  })
})

test("unknown native writers and failed owner release keep the durable operation held", async () => {
  await using f = await fixture()
  await f.run(async () => {
    let unknown = true
    let releaseFails = true
    RuntimeMaintenance.configure({ required: ["writer"] })
    RuntimeMaintenance.register("writer", {
      version: 1,
      async suspend() {},
      async drain() {},
      async inspect() {
        return unknown
          ? [
              {
                code: "physical_writer_unknown",
                owner: "writer",
                label: "Reconcile the physical writer",
                recoverable: true,
              },
            ]
          : []
      },
      async release() {
        if (releaseFails) throw new Error("Fixture release incomplete")
      },
    })
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    await expect(RuntimeMaintenance.drain(lease)).rejects.toThrow()
    expect((await RuntimeMaintenance.status())?.phase).toBe("draining")
    await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
    unknown = false
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    await expect(RuntimeMaintenance.release(lease)).rejects.toThrow("release incomplete")
    expect((await RuntimeMaintenance.status())?.phase).toBe("releasing")
    await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
    releaseFails = false
    await RuntimeMaintenance.release(lease)
    expect((await RuntimeMaintenance.status())?.phase).toBe("released")
  })
})

test("a committed begin with a lost SQL acknowledgement reconciles the original identity without reopening admission", async () => {
  await using f = await fixture()
  await f.run(async () => {
    RuntimeMaintenance.configure({ required: ["writer"] })
    RuntimeMaintenance.register("writer", {
      version: 1,
      async suspend() {},
      async drain() {},
      async inspect() {
        return []
      },
      async release() {},
    })
    const original = f.store.transaction.bind(f.store)
    let lost = false
    using fault = spyOn(f.store, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
        const result = await original(body, options)
        if (!lost && options?.operationID?.startsWith("runtime-maintenance-begin:")) {
          lost = true
          throw new StorageCommitUnknownError(options.operationID, new Error("Fixture commit acknowledgement lost"))
        }
        return result
      },
    )
    const input = { purpose: "organization-backup" as const, requestID: actor.requestID, actor }
    await expect(RuntimeMaintenance.begin(input)).rejects.toThrow("did not confirm")
    const retained = await RuntimeMaintenance.status()
    if (!retained) throw new Error("Expected the actual committed maintenance operation")
    expect(retained.phase).toBe("draining")
    await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
    const lease = await RuntimeMaintenance.begin(input)
    expect(lease.maintenanceID).toBe(retained.maintenanceID)
    expect(await Storage.count({ prefix: ["runtime_maintenance", "operations"] })).toBe(1)
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    await RuntimeMaintenance.release(lease)
    expect((await RuntimeMaintenance.begin(input)).maintenanceID).toBe(lease.maintenanceID)
    await RuntimeMaintenance.assertAdmission()
    await expect(RuntimeMaintenance.begin({ ...input, purpose: "organization-restore" })).rejects.toThrow()
    await RuntimeMaintenance.assertAdmission()
  })
})

test("native admission reopens only after the original released commit is confirmed, including a lost acknowledgement", async () => {
  await using f = await fixture()
  await f.run(async () => {
    let releases = 0
    let reopened = 0
    RuntimeMaintenance.configure({ required: ["writer"] })
    RuntimeMaintenance.register("writer", {
      version: 1,
      async suspend() {},
      async drain() {},
      async inspect() {
        return []
      },
      async release() {
        releases++
      },
      async released(context) {
        await RuntimeMaintenance.assertReleased(context.lease)
        await expect(RuntimeMaintenance.assertReleased({ ...context.lease })).rejects.toThrow()
        reopened++
      },
    })
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    const original = f.store.transaction.bind(f.store)
    let lost = false
    using fault = spyOn(f.store, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
        const result = await original(body, options)
        const info = RuntimeMaintenance.Info.safeParse(result)
        if (!lost && info.success && info.data.phase === "released") {
          lost = true
          throw new StorageCommitUnknownError(
            "runtime-maintenance-release",
            new Error("Fixture released acknowledgement lost"),
          )
        }
        return result
      },
    )
    await expect(RuntimeMaintenance.release(lease)).rejects.toThrow("did not confirm")
    expect((await RuntimeMaintenance.status())?.phase).toBe("released")
    expect(releases).toBe(1)
    expect(reopened).toBe(0)
    await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
    await RuntimeMaintenance.release(lease)
    expect(releases).toBe(1)
    expect(reopened).toBe(1)
    await RuntimeMaintenance.assertAdmission()
  })
})

test("a pre-cancelled maintenance request leaves ordinary admission and canonical state unchanged", async () => {
  await using f = await fixture()
  await f.run(async () => {
    RuntimeMaintenance.configure({ required: ["writer"] })
    RuntimeMaintenance.register("writer", {
      version: 1,
      async suspend() {},
      async drain() {},
      async inspect() {
        return []
      },
      async release() {},
    })
    await expect(
      RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: actor.requestID,
        actor,
        signal: AbortSignal.abort(new Error("Fixture pre-cancelled")),
      }),
    ).rejects.toThrow("pre-cancelled")
    await RuntimeMaintenance.assertAdmission()
    expect(await RuntimeMaintenance.status()).toBeUndefined()
  })
})

test("a cold Runtime retains a previous cohort's hold and cannot reuse its old lease or idempotent request as reconciliation", async () => {
  await using f = await fixture()
  const prior = await f.run(async () => {
    RuntimeMaintenance.configure({ required: ["writer"] })
    RuntimeMaintenance.register("writer", {
      version: 1,
      async suspend() {},
      async drain() {},
      async inspect() {
        return []
      },
      async release() {},
    })
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    return lease
  })
  await f.restart()
  await f.run(async () => {
    RuntimeMaintenance.configure({ required: ["writer"] })
    RuntimeMaintenance.register("writer", {
      version: 1,
      async suspend() {},
      async drain() {},
      async inspect() {
        return []
      },
      async release() {},
    })
    expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
    await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
    await expect(RuntimeMaintenance.release(prior)).rejects.toThrow()
    await expect(
      RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor }),
    ).rejects.toThrow("reconciliation")
    await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
  })
})
