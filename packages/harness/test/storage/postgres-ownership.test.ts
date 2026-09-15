import { expect, test } from "bun:test"
import { SQL } from "bun"
import { createHash } from "node:crypto"
import { TransactionalStore } from "../../src/storage/transactional-store"

const url = process.env.SYNERGY_TEST_POSTGRES_URL

test.skipIf(!url)(
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
