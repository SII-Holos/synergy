import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { MaintenanceRetirementRecords } from "../../src/storage/maintenance-retirement-records"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore, StoreTransaction, type TransactionOptions } from "../../src/storage/transactional-store"
import { SessionPreparingError, StorageCommitUnknownError, StorageIntegrityError } from "../../src/storage/errors"
import type { SqlQueryOptions, SqlRow, SqlValue } from "../../src/storage/sql-contract"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestBackends, storageTestOptions } from "../support/storage-backends"

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

test("empty maintenance admission reads its canonical point and prefix witness in one native statement", async () => {
  await using f = await fixture()
  await f.run(() =>
    Storage.snapshot(async (tx) => {
      const query = tx.raw.query.bind(tx.raw)
      let calls = 0
      using reads = spyOn(tx.raw, "query").mockImplementation(
        <Row extends SqlRow = SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions) => {
          calls++
          return query<Row>(statement, values, options)
        },
      )
      expect(await RuntimeMaintenance.status()).toBeUndefined()
      expect(calls).toBe(1)
    }),
  )
})

test("maintenance point records remain authoritative when their derived node is absent or collides", async () => {
  await using f = await fixture()
  const key = ["runtime_maintenance", "current"]
  await f.store.write(key, { maintenanceID: "missing-operation" })
  await f.store.transaction((tx) =>
    tx.raw.query(
      "DELETE FROM storage_nodes WHERE namespace = ? AND key_id IN (SELECT key_id FROM storage_records WHERE namespace = ? AND key_text = ?)",
      [f.store.options.namespace, f.store.options.namespace, JSON.stringify(key)],
    ),
  )
  await f.run(async () => {
    expect(await Storage.queryKeys({ prefix: ["runtime_maintenance"], limit: 1 })).toEqual([])
    const blocked = await RuntimeMaintenance.assertAdmission().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(blocked).toBeInstanceOf(RuntimeMaintenance.Blocked)
    if (!(blocked instanceof Error)) throw new Error("The canonical pointer must refuse its missing operation")
    expect(blocked.message).toBe("Maintenance operation is missing or inconsistent")
    await f.store.remove(key)
    expect(await RuntimeMaintenance.status()).toBeUndefined()
    await f.store.transaction((tx) =>
      tx.raw.query("UPDATE storage_records SET key_text = ? WHERE namespace = ? AND key_text = ?", [
        JSON.stringify(["foreign-key"]),
        f.store.options.namespace,
        JSON.stringify(key),
      ]),
    )
    const collision = await RuntimeMaintenance.status().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(collision).toBeInstanceOf(StorageIntegrityError)
  })
})

test("maintenance parses its canonical point before an unused malformed prefix witness", async () => {
  await using f = await fixture()
  await f.run(() =>
    Storage.transaction(async (tx) => {
      const current = ["runtime_maintenance", "current"]
      const orphan = ["runtime_maintenance", "0"]
      await tx.write(current, { maintenanceID: 7 })
      await tx.write(orphan, {})
      await tx.raw.query("UPDATE storage_records SET key_text = ? WHERE namespace = ? AND key_text = ?", [
        "{",
        f.store.options.namespace,
        JSON.stringify(orphan),
      ])
      const malformed = await RuntimeMaintenance.status().then(
        () => undefined,
        (error: unknown) => error,
      )
      if (!(malformed instanceof Error)) throw new Error("The original malformed pointer must be refused")
      expect(malformed.name).toBe("ZodError")
      await tx.raw.query("UPDATE storage_records SET body = ? WHERE namespace = ? AND key_text = ?", [
        "{",
        f.store.options.namespace,
        JSON.stringify(current),
      ])
      const encoding = await RuntimeMaintenance.status().then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(encoding).toBeInstanceOf(StorageIntegrityError)
      await tx.remove(current)
      const prefix = await RuntimeMaintenance.status().then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(prefix).toBeInstanceOf(SyntaxError)
      await tx.raw.query("UPDATE storage_records SET key_text = ? WHERE namespace = ? AND key_text = ?", [
        "null",
        f.store.options.namespace,
        "{",
      ])
      const malformedKey = await RuntimeMaintenance.status().then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(malformedKey).toBeInstanceOf(RuntimeMaintenance.Blocked)
    }),
  )
})

test("maintenance prefix observations see staged orphan writes, removal and rollback without cached authority", async () => {
  await using f = await fixture()
  const rollback = new Error("Original maintenance observation rollback")
  await f.run(async () => {
    const outcome = await Storage.transaction(async (tx) => {
      expect(await RuntimeMaintenance.status()).toBeUndefined()
      await tx.write(["runtime_maintenance", "operations", "orphan"], { preserved: true })
      const orphan = await RuntimeMaintenance.assertAdmission().then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(orphan).toBeInstanceOf(RuntimeMaintenance.Blocked)
      await tx.removeTree(["runtime_maintenance"])
      expect(await RuntimeMaintenance.status()).toBeUndefined()
      await tx.write(["runtime_maintenance", "operations", "rolled-back"], { preserved: true })
      throw rollback
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(outcome).toBe(rollback)
    expect(await RuntimeMaintenance.status()).toBeUndefined()
  })
})

test.skipIf(storageTestBackends().at(-1) !== "sqlite")(
  "a non-null maintenance pointer never evaluates the original prefix traversal",
  async () => {
    await using f = await fixture()
    await f.store.write(["runtime_maintenance", "current"], { maintenanceID: "missing-operation" })
    let pointerOutcome: unknown
    let failedPrefix: unknown
    const outcome = await f
      .run(() =>
        Storage.transaction(async (tx) => {
          await tx.raw.query(
            "CREATE TEMP VIEW storage_nodes AS SELECT namespace, abs(-9223372036854775807 - (segment <> '')) AS key_id, parent_id, segment FROM main.storage_nodes",
          )
          pointerOutcome = await RuntimeMaintenance.status().then(
            () => undefined,
            (error: unknown) => error,
          )
          if (!(pointerOutcome instanceof Error))
            throw new Error("The original canonical pointer must still refuse its missing operation")
          expect(pointerOutcome.message).toBe("Maintenance operation is missing or inconsistent")
          failedPrefix = await tx.queryKeys({ prefix: ["runtime_maintenance"], limit: 1 }).then(
            () => undefined,
            (error: unknown) => error,
          )
          if (!(failedPrefix instanceof Error))
            throw new Error("The original SQLite prefix must evaluate the controlled fault")
          expect(failedPrefix.message).toBe("integer overflow")
          throw failedPrefix
        }),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(pointerOutcome).toBeInstanceOf(RuntimeMaintenance.Blocked)
    expect(failedPrefix).toBeInstanceOf(Error)
    expect(outcome).toBe(failedPrefix)
    await f.store.transaction(async (tx) => {
      expect(
        await tx.raw.query("SELECT name FROM sqlite_temp_master WHERE type = 'view' AND name = 'storage_nodes'"),
      ).toEqual([])
    })
  },
)

for (const present of [false, true]) {
  test(`maintenance point-prefix selectors reject an unpublished Session prefix with a ${present ? "present" : "missing"} external point`, async () => {
    await using f = await fixture()
    const sessionID = "pending-selector"
    const prefix = ["sessions", "scope", sessionID]
    const point = present ? ["external-point"] : []
    const value = { preserved: true }
    await f.store.write([...prefix, "info"], { id: sessionID })
    if (present) await f.store.write(point, value)
    await f.store.write(["compat_pending", sessionID], { sessionID })
    let admitted: unknown
    const error = await f.store
      .snapshot(async (tx) => {
        tx.restrictToPublishedOwners()
        return tx.readWithPrefixWitness(point, prefix)
      })
      .then(
        (value) => {
          admitted = value
        },
        (error: unknown) => error,
      )
    expect(admitted).toBeUndefined()
    expect(error).toBeInstanceOf(SessionPreparingError)
    if (!(error instanceof SessionPreparingError))
      throw new Error("Both declared selectors must belong to published owners")
    expect(error.data.sessionID).toBe(sessionID)
    await f.store.remove(["compat_pending", sessionID])
    await f.store.write(["compat_pending", "unrelated-selector"], { sessionID: "unrelated-selector" })
    expect(
      await f.store.snapshot(async (tx) => {
        tx.restrictToPublishedOwners()
        return tx.readWithPrefixWitness(point, prefix)
      }),
    ).toEqual(present ? { found: true, value } : { found: false, hasPrefixRecords: true })
  })
}
