import { expect, spyOn, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { Storage } from "../../src/storage/storage"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { StorageCommitUnknownError, StorageConflictError, StorageOwnershipError } from "../../src/storage/errors"
import type { StoreTransaction, TransactionOptions } from "../../src/storage/transactional-store"
import { RuntimeContext } from "../../src/lifecycle/context"
import { testRuntime } from "../support/runtime"

function observe(callback: (error: unknown) => undefined) {
  const register: unknown = Reflect.get(Storage, "afterFailure")
  if (typeof register === "function") register(callback)
}

test("native transaction failure observation receives the original SQLite FULL after its actual writer exits", async () => {
  const opened = new Map<string, SqliteDriver>()
  const open = SqliteDriver.open
  using observed = spyOn(SqliteDriver, "open").mockImplementation(async (...args) => {
    const driver = await open(...args)
    opened.set(args[0], driver)
    return driver
  })
  await using runtime = await testRuntime()
  observed.mockRestore()
  await runtime.run(async () => {
    const store = Storage.current().store
    if (store.options.backend !== "sqlite") throw new Error("Expected the original SQLite owner")
    const driver = opened.get(store.options.filename)
    if (!driver) throw new Error("Original SQLite writer was not observed")
    const owner = RuntimeContext.current()
    const received: Array<{ error: unknown; inTransaction: boolean; sameRuntime: boolean }> = []
    await Storage.write(["native-original-retained"], { preserved: true })
    const maximum = await driver.transaction(async (connection) => {
      const [original] = await connection.query<{ max_page_count: number | bigint }>("PRAGMA max_page_count")
      const [pages] = await connection.query<{ page_count: number | bigint }>("PRAGMA page_count")
      const limit = Number(pages?.page_count) + 2
      if (!Number.isSafeInteger(limit) || limit < 3) throw new Error("Unexpected native page count")
      const [installed] = await connection.query<{ max_page_count: number | bigint }>(
        `PRAGMA max_page_count = ${limit}`,
      )
      expect(Number(installed?.max_page_count)).toBe(limit)
      return Number(original?.max_page_count)
    })
    let failure: unknown
    try {
      try {
        await Storage.transaction(async () => {
          observe((error) => {
            received.push({
              error,
              inTransaction: Storage.inTransaction(),
              sameRuntime: RuntimeContext.current() === owner,
            })
          })
          await Storage.write(["native-full-attempt"], { payload: randomBytes(1024 * 1024).toString("base64") })
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect(failure && typeof failure === "object" && "code" in failure ? failure.code : undefined).toBe("SQLITE_FULL")
      expect(received).toHaveLength(1)
      expect(received[0]!.error).toBe(failure)
      expect(received[0]!.inTransaction).toBe(false)
      expect(received[0]!.sameRuntime).toBe(true)
    } finally {
      await driver.transaction((connection) => connection.query(`PRAGMA max_page_count = ${maximum}`))
    }
    expect((await Storage.readMany([["native-full-attempt"]]))[0]).toBeUndefined()
    expect(await Storage.read(["native-original-retained"])).toEqual({ preserved: true })
  })
})

test("native failure observers join the outer outcome and do not misclassify caught nested or committed notification errors", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const received: unknown[] = []
    const nested = new Error("Caught native nested failure")
    const outer = new Error("Original native outer failure")
    await Storage.transaction(async () => {
      try {
        await Storage.transaction(async () => {
          observe((error) => {
            received.push(error)
          })
          throw nested
        })
      } catch (error) {
        expect(error).toBe(nested)
      }
      await Storage.write(["native-caught-inner"], true)
      Storage.afterCommit(() => {
        throw new Error("Notification unavailable after native COMMIT")
      })
    })
    expect(received).toEqual([])
    await expect(
      Storage.transaction(async () => {
        await Storage.transaction(async () => {
          observe((error) => {
            received.push(error)
          })
        })
        await Storage.write(["native-outer-aborted"], true)
        throw outer
      }),
    ).rejects.toBe(outer)
    expect(received).toEqual([outer])
    expect(await Storage.read(["native-caught-inner"])).toBe(true)
    expect((await Storage.readMany([["native-outer-aborted"]]))[0]).toBeUndefined()
  })
})

test("native failure observation rejects readonly, foreign Runtime and escaped write frames", async () => {
  await using first = await testRuntime()
  await using second = await testRuntime()
  await first.run(async () => {
    const register: unknown = Reflect.get(Storage, "afterFailure")
    expect(typeof register).toBe("function")
    if (typeof register !== "function") throw new Error("Original native failure observer is unavailable")
    expect(() => register(() => {})).toThrow(StorageConflictError)
    await Storage.snapshot(async () => {
      expect(() => register(() => {})).toThrow(StorageConflictError)
    })
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let escaped: Promise<void> | undefined
    await Storage.transaction(async () => {
      escaped = released.then(() => {
        expect(() => register(() => {})).toThrow(StorageOwnershipError)
      })
      let foreignEntered = false
      expect(() =>
        second.run(() => {
          foreignEntered = true
          register(() => {})
        }),
      ).toThrow("Cannot switch runtimes inside a storage transaction")
      expect(foreignEntered).toBe(false)
      RuntimeContext.exit(() => expect(() => register(() => {})).toThrow(StorageConflictError))
    })
    expect(escaped).toBeDefined()
    release()
    await escaped
  })
})

test("throwing native failure observers preserve the original error and remaining finalization", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const received: unknown[] = []
    const original = new Error("Original native writer failed")
    const observer = new Error("Observer failed")
    await expect(
      Storage.transaction(async () => {
        observe(() => {
          throw observer
        })
        observe((error) => {
          received.push(error)
        })
        await Storage.write(["native-observer-rollback"], true)
        throw original
      }),
    ).rejects.toBe(original)
    expect(received).toEqual([original])
    expect((await Storage.readMany([["native-observer-rollback"]]))[0]).toBeUndefined()
    await Storage.write(["native-owner-after-observers"], true)
    expect(await Storage.read(["native-owner-after-observers"])).toBe(true)
  })
})

test("a native commit with unknown acknowledgment keeps its actual receipt and original unknown failure", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const store = Storage.current().store
    const transaction = store.transaction.bind(store)
    const unknown = new StorageCommitUnknownError("native-original", new Error("Original COMMIT ACK lost"))
    const received: unknown[] = []
    let lost = false
    using uncertain = spyOn(store, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
        const result = await transaction(body, options)
        if (!lost) {
          lost = true
          throw unknown
        }
        return result
      },
    )
    await expect(
      Storage.transaction(async () => {
        observe((error) => {
          received.push(error)
        })
        await Storage.write(["native-unknown-receipt"], { committed: true })
      }),
    ).rejects.toBe(unknown)
    expect(received).toEqual([unknown])
    expect(await Storage.read(["native-unknown-receipt"])).toEqual({ committed: true })
  })
})
