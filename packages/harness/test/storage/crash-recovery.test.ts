import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { SqliteDriver } from "../../src/storage/sqlite-driver"

const entry = new URL("../../src/storage/transactional-store.ts", import.meta.url).href

test("closing a store with an already closed driver preserves the original failure", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "storage-closed-"))
  const filename = path.join(root, "agent.sqlite")
  const open = SqliteDriver.open
  let driver: SqliteDriver | undefined
  using observed = spyOn(SqliteDriver, "open").mockImplementation(async (...args) => {
    driver = await open(...args)
    return driver
  })
  const store = await TransactionalStore.open({ backend: "sqlite", filename, namespace: "closed" })
  try {
    await store.write(["record"], { preserved: true })
    await driver!.close()
    const original = new Error("original operation failure")
    await expect(
      (async () => {
        try {
          throw original
        } finally {
          await store.close()
        }
      })(),
    ).rejects.toBe(original)
    const recovered = await TransactionalStore.open({ backend: "sqlite", filename, namespace: "closed", recover: true })
    try {
      expect(await recovered.read<{ preserved: boolean }>(["record"])).toEqual({ preserved: true })
    } finally {
      await recovered.close()
    }
  } finally {
    await store.close().catch(() => {})
    await fs.rm(root, { recursive: true, force: true })
  }
})

for (const stage of ["inside", "committed"] as const) {
  test(`process loss ${stage} a transaction preserves its atomic boundary`, async () => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "storage-crash-"))
    const filename = path.join(root, "agent.sqlite")
    const ready = Promise.withResolvers<void>()
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--eval",
        `
        const { TransactionalStore } = await import(process.env.TEST_STORAGE_MODULE)
        const store = await TransactionalStore.open({ backend: "sqlite", filename: process.env.TEST_STORAGE_FILE, namespace: "crash" })
        await store.transaction(async (tx) => {
          await tx.write(["session"], { title: "committed" })
          if (process.env.TEST_STORAGE_STAGE === "inside") {
            process.send({ ready: true })
            await new Promise(() => {})
          }
          await tx.write(["index"], { session: "session" })
          return { accepted: true }
        }, { operationID: "command", requestHash: "input" })
        process.send({ ready: true })
        await new Promise(() => {})
      `,
      ],
      env: { ...process.env, TEST_STORAGE_MODULE: entry, TEST_STORAGE_FILE: filename, TEST_STORAGE_STAGE: stage },
      stdout: "ignore",
      stderr: "pipe",
      ipc(message: unknown) {
        if (message && typeof message === "object" && "ready" in message) ready.resolve()
      },
      onExit(_child, code) {
        ready.reject(new Error(`Child exited before the crash boundary: ${code}`))
      },
    })
    const stderr = new Response(child.stderr).text()
    const deadline = setTimeout(() => ready.reject(new Error("Storage crash fixture did not become ready")), 10_000)
    try {
      await ready.promise
      child.kill("SIGKILL")
      await child.exited
      await stderr
      let reopened: TransactionalStore | undefined
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          reopened = await TransactionalStore.open({
            backend: "sqlite",
            filename,
            namespace: "crash",
            recover: true,
            mustExist: true,
          })
          break
        } catch (error) {
          if (attempt === 99) throw error
          await Bun.sleep(20)
        }
      }
      if (!reopened) throw new Error("Could not reopen the interrupted dataset")
      try {
        if (stage === "inside") {
          expect(await reopened.readMany([["session"], ["index"]])).toEqual([undefined, undefined])
          expect(await reopened.operationReceipt("command")).toBeUndefined()
        } else {
          expect(await reopened.readMany([["session"], ["index"]])).toEqual([
            { title: "committed" },
            { session: "session" },
          ])
          expect(
            await reopened.transaction<{ accepted: boolean }>(
              async () => {
                throw new Error("must not replay committed work")
              },
              { operationID: "command", requestHash: "input" },
            ),
          ).toEqual({ accepted: true })
        }
      } finally {
        await reopened.close()
      }
    } finally {
      clearTimeout(deadline)
      child.kill()
      await child.exited
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 15_000)
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test.skipIf(process.platform === "win32")(
    `process-group ${signal} allows the owner to persist terminal evidence before closing storage`,
    async () => {
      const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "storage-signal-"))
      const filename = path.join(root, "agent.sqlite")
      const ready = Promise.withResolvers<void>()
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "--eval",
          `
          const { TransactionalStore } = await import(process.env.TEST_STORAGE_MODULE)
          const stopping = Promise.withResolvers()
          process.on("SIGINT", () => stopping.resolve())
          process.on("SIGTERM", () => stopping.resolve())
          const store = await TransactionalStore.open({ backend: "sqlite", filename: process.env.TEST_STORAGE_FILE, namespace: "signal" })
          try {
            process.send({ ready: true })
            await stopping.promise
            await store.transaction(async (tx) => {
              await tx.write(["terminal"], { status: "cancelled" })
              await tx.write(["accounting"], { complete: false })
            })
          } finally {
            await store.close()
            process.disconnect()
          }
        `,
        ],
        detached: true,
        env: { ...process.env, TEST_STORAGE_MODULE: entry, TEST_STORAGE_FILE: filename },
        stdout: "ignore",
        stderr: "pipe",
        ipc(message: unknown) {
          if (message && typeof message === "object" && "ready" in message) ready.resolve()
        },
        onExit(_child, code) {
          ready.reject(new Error(`Child exited before the signal boundary: ${code}`))
        },
      })
      const stderr = new Response(child.stderr).text()
      try {
        await ready.promise
        process.kill(-child.pid, signal)
        expect({ code: await child.exited, stderr: await stderr }).toEqual({ code: 0, stderr: "" })
        const reopened = await TransactionalStore.open({ backend: "sqlite", filename, namespace: "signal" })
        try {
          expect(await reopened.readMany([["terminal"], ["accounting"]])).toEqual([
            { status: "cancelled" },
            { complete: false },
          ])
        } finally {
          await reopened.close()
        }
      } finally {
        child.kill("SIGKILL")
        await child.exited
        await fs.rm(root, { recursive: true, force: true })
      }
    },
    15_000,
  )
}
