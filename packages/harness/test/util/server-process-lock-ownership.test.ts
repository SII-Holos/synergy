import { expect, test } from "bun:test"
import path from "node:path"
import { ServerProcessLock } from "../../src/util/server-process-lock"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

test("installed writer evidence requires the actual current native lock and its original Runtime and Store", async () => {
  await using runtime = await testRuntime()
  await using foreign = await testRuntime()
  await runtime.run(async () => {
    const proof = await ServerProcessLock.currentOwnership()
    expect(() => ServerProcessLock.assertCurrent(proof)).not.toThrow()
    await ServerProcessLock.verifyOwnership(proof)
    const current = Storage.current()
    const other = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(runtime.host.root, "foreign.sqlite"),
      namespace: "foreign",
    })
    try {
      await Storage.provide({ ...current, store: other }, async () => {
        expect(() => ServerProcessLock.assertCurrent(proof)).toThrow("namespace")
        await expect(ServerProcessLock.currentOwnership()).rejects.toThrow("namespace")
      })
      await foreign.run(async () => {
        expect(() => ServerProcessLock.assertCurrent(proof)).toThrow("Runtime")
      })
      const lock = ServerProcessLock.path()
      const original = await Bun.file(lock).text()
      try {
        const replacement = { ...JSON.parse(original), ownerToken: crypto.randomUUID() }
        await Bun.write(lock, JSON.stringify(replacement))
        await expect(ServerProcessLock.verifyOwnership(proof)).rejects.toThrow("native")
        await expect(ServerProcessLock.currentOwnership()).rejects.toThrow("native")
      } finally {
        await Bun.write(lock, original)
      }
      await ServerProcessLock.verifyOwnership(proof)
      expect(() => ServerProcessLock.assertCurrent({ kind: "runtime-writer" })).toThrow("native")
    } finally {
      await other.close()
    }
  })
})

test("closing the actual Runtime permanently revokes its writer evidence", async () => {
  const runtime = await testRuntime()
  const proof = await runtime.run(() => ServerProcessLock.currentOwnership())
  await runtime.close()
  await using other = await testRuntime()
  await other.run(async () => {
    expect(() => ServerProcessLock.assertCurrent(proof)).toThrow("Installed writer native ownership has been released")
    await expect(ServerProcessLock.verifyOwnership(proof)).rejects.toThrow(
      "Installed writer native ownership has been released",
    )
  })
})

test("a standalone native Store may acquire its own lock without becoming an installed Runtime writer", async () => {
  await using directory = await tmpdir()
  const lock = await ServerProcessLock.acquire(path.join(directory.path, "standalone.lock"), "oneshot")
  await lock.release()
  expect(await Bun.file(path.join(directory.path, "standalone.lock")).exists()).toBe(false)
})
