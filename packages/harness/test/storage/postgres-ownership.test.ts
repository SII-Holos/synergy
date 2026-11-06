import { expect, test } from "bun:test"
import { SQL } from "bun"
import { createHash } from "node:crypto"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { PostgresDriver } from "../../src/storage/postgres-driver"
import { NotFoundError } from "../../src/storage/errors"

import { storageTestBackends } from "../support/storage-backends"

const enabled = storageTestBackends().includes("postgres")
const url = process.env.SYNERGY_TEST_POSTGRES_URL

test.skipIf(!enabled)(
  "PostgreSQL ownership loss rolls back work and requires explicit takeover",
  async () => {
    const namespace = crypto.randomUUID()
    const store = await TransactionalStore.open({ backend: "postgres", namespace, url: url! })
    const admin = new SQL(url!)
    let replacement: TransactionalStore | undefined
    try {
      await store.write(["value"], { count: 1 })
      const digest = createHash("sha256").update(namespace).digest()
      const [owner] =
        await admin`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid::bigint = ${digest.readUInt32BE(0)} AND objid::bigint = ${digest.readUInt32BE(4)} AND objsubid = 2 AND granted`
      expect(owner).toBeDefined()
      await expect(
        store.transaction(async (tx) => {
          await tx.write(["value"], { count: 2 })
          await admin`SELECT pg_terminate_backend(${owner.pid})`
        }),
      ).rejects.toThrow()
      expect(await store.read<{ count: number }>(["value"])).toEqual({ count: 1 })
      await expect(TransactionalStore.open({ backend: "postgres", namespace, url: url! })).rejects.toThrow(
        "did not release ownership",
      )
      replacement = await TransactionalStore.open({ backend: "postgres", namespace, url: url!, recover: true })
      await replacement.write(["value"], { count: 3 })
      await expect(store.write(["value"], { count: 4 })).rejects.toThrow()
      expect(await replacement.read<{ count: number }>(["value"])).toEqual({ count: 3 })
    } finally {
      await store.close()
      await replacement?.close()
      await admin.close()
    }
  },
  30000,
)

test.skipIf(!enabled).each(["withdrawn", "current"] as const)(
  "real PostgreSQL checks %s authority after its post-body ownership SQL response",
  async (authority) => {
    const store = await TransactionalStore.open({ backend: "postgres", namespace: crypto.randomUUID(), url: url! })
    const driver = Reflect.get(store, "driver") as PostgresDriver
    const owner = Reflect.get(driver, "owner") as SQL
    const waiting = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const controller = new AbortController()
    let ownershipChecks = 0
    let pending: Promise<unknown> | undefined
    try {
      const incoming = ["host_connection", "incoming", "commit-fixture"]
      const invitation = ["host_connection", "invitation"]
      const peer = ["host_connection", "peers", "commit-fixture"]
      await store.transaction(async (tx) => {
        await tx.write(incoming, { phase: "pending" })
        await tx.write(invitation, { digest: "retained" })
      })
      Reflect.set(
        driver,
        "owner",
        new Proxy(owner, {
          apply(target, receiver, args) {
            const response = Reflect.apply(target, receiver, args)
            return Promise.resolve(response).then(async (rows) => {
              if (++ownershipChecks === 2) {
                waiting.resolve()
                await released.promise
              }
              return rows
            })
          },
        }),
      )
      pending = store.transaction(
        async (tx) => {
          controller.signal.throwIfAborted()
          await tx.write(peer, { approved: true })
          await tx.write(incoming, { phase: "approved" })
          await tx.remove(invitation)
          controller.signal.throwIfAborted()
        },
        { commitGuard: () => controller.signal.throwIfAborted() },
      )
      const settled = pending.then(
        () => undefined,
        (error: unknown) => error,
      )
      await Promise.race([
        waiting.promise,
        settled.then((error) => {
          throw error
        }),
      ])
      if (authority === "withdrawn") controller.abort(new Error("authority withdrawn after ownership SQL"))
      released.resolve()
      const failure = await settled
      if (authority === "withdrawn") {
        expect(failure).toBeInstanceOf(Error)
        expect(await store.read<{ phase: string }>(incoming)).toEqual({ phase: "pending" })
        expect(await store.read<{ digest: string }>(invitation)).toEqual({ digest: "retained" })
        await expect(store.read(peer)).rejects.toBeInstanceOf(NotFoundError)
      } else {
        expect(failure).toBeUndefined()
        expect(await store.read<{ phase: string }>(incoming)).toEqual({ phase: "approved" })
        expect(await store.read<{ approved: boolean }>(peer)).toEqual({ approved: true })
        await expect(store.read(invitation)).rejects.toBeInstanceOf(NotFoundError)
      }
    } finally {
      released.resolve()
      await pending?.catch(() => {})
      Reflect.set(driver, "owner", owner)
      await store.close()
    }
  },
  30_000,
)
