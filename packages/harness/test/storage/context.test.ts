import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"

const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "storage-context-"))
const store = await TransactionalStore.open({
  backend: "sqlite",
  namespace: "context",
  filename: path.join(root, "store.sqlite"),
})
afterAll(async () => {
  await store.close()
  await fs.rm(root, { recursive: true, force: true })
})

test("nested domain writes join the caller's transaction and publish only after commit", async () => {
  const published: number[] = []
  await Storage.provide({ store, artifactDirectory: root }, async () => {
    await expect(
      Storage.transaction(async () => {
        await Storage.write(["left"], { value: 1 })
        await Storage.transaction(async () => {
          await Storage.write(["right"], { value: 2 })
          Storage.afterCommit(() => {
            published.push(1)
          })
        })
        expect(published).toEqual([])
        throw new Error("rollback")
      }),
    ).rejects.toThrow("rollback")
    expect(await Storage.readMany([["left"], ["right"]])).toEqual([undefined, undefined])
    expect(published).toEqual([])
    await Storage.transaction(async () => {
      await Storage.write(["left"], { value: 3 })
      Storage.afterCommit(async () => {
        published.push((await Storage.read<{ value: number }>(["left"])).value)
      })
    })
    expect(published).toEqual([3])
  })
})

test("snapshots read their own stable view and reject transitive writes", async () => {
  await Storage.provide({ store, artifactDirectory: root }, async () => {
    await Storage.write(["snapshot"], 1)
    await expect(
      Storage.snapshot(async () => {
        expect(await Storage.read<number>(["snapshot"])).toBe(1)
        await Storage.write(["snapshot"], 2)
      }),
    ).rejects.toThrow("read-only")
    expect(await Storage.read<number>(["snapshot"])).toBe(1)
  })
})

test("notification failure does not turn a confirmed commit into a retryable write failure", async () => {
  await Storage.provide({ store, artifactDirectory: root }, async () => {
    let lastObserver = false
    await Storage.transaction(async () => {
      await Storage.write(["confirmed"], 42)
      Storage.afterCommit(() => {
        throw new Error("observer unavailable")
      })
      Storage.afterCommit(() => {
        lastObserver = true
      })
    })
    expect(await Storage.read<number>(["confirmed"])).toBe(42)
    expect(lastObserver).toBe(true)
  })
})

test("deleted sessions reject delayed rollout and inbox writes in the same transaction", async () => {
  await Storage.provide({ store, artifactDirectory: root }, async () => {
    const session = ["sessions", "scope_deleted", "ses_deleted"]
    await Storage.write([...session, "info"], { id: "ses_deleted" })
    await Storage.removeTree(session)
    for (const suffix of [["rollout", "journal", "head"], ["inbox", "late"], ["info"]]) {
      await expect(
        Storage.transaction(async () => {
          await Storage.write(["unrelated", "late-owner"], true)
          await Storage.write([...session, ...suffix], { delayed: true })
        }),
      ).rejects.toThrow("deleted")
    }
    expect(await Storage.list(session)).toEqual([])
    expect(await Storage.readMany([["unrelated", "late-owner"]])).toEqual([undefined])
  })
})
