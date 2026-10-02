import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestBackends } from "../support/storage-backends"
import { storageTestRuntime } from "../support/storage-runtime"

const runtime = await storageTestRuntime()
afterAll(() => runtime.close())

for (const backend of storageTestBackends()) {
  test(
    `${backend} prune budgets protect recent, active and artifact-heavy owners and cancellation rolls back`,
    () =>
      runtime.run(async () => {
        const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "prune-contract-"))
        const namespace = crypto.randomUUID()
        const store = await TransactionalStore.open(
          backend === "sqlite"
            ? { backend, namespace, filename: path.join(root, "prune.sqlite") }
            : { backend: "postgres", namespace, url: process.env.SYNERGY_TEST_POSTGRES_URL! },
        )
        const prefix = ["sessions", "scope", "session", "rollout"]
        const limits = { records: 2048, nodes: 4096, artifacts: 256 }
        const cutoff = Date.now() + 60_000
        try {
          await store.transaction((tx) =>
            tx.writeMany([
              { key: ["sessions", "scope", "session", "info"], value: { id: "session" } },
              { key: [...prefix, "info"], value: { retained: true } },
            ]),
          )
          for (const maintenance of [false, true]) {
            expect(
              await store.pruneTreeWithinBudget(prefix, { limits, cutoff: 0, active: () => false, maintenance }),
            ).toMatchObject({ records: 0, deferred: "recent" })
            let checks = 0
            expect(
              await store.pruneTreeWithinBudget(prefix, { limits, cutoff, active: () => ++checks > 1, maintenance }),
            ).toMatchObject({ records: 0, deferred: "active" })
          }
          await store.transaction((tx) =>
            tx.writeArtifacts(
              Array.from({ length: 257 }, (_, index) => ({
                key: [...prefix, "artifacts", String(index)],
                location: {
                  pack: "00000000-0000-0000-0000-000000000000.pack",
                  codec: "raw",
                  blockOffset: 0,
                  blockBytes: 1,
                  decodedBytes: 1,
                  offset: 0,
                  size: 1,
                  sha256: "0".repeat(64),
                },
              })),
            ),
          )
          expect(await store.pruneTreeWithinBudget(prefix, { limits, cutoff, active: () => false })).toMatchObject({
            records: 0,
            deferred: "artifacts",
          })
          const controller = new AbortController()
          controller.abort(new Error("cancelled maintenance"))
          await expect(
            store.transaction((tx) => tx.pruneTree(prefix, { maintenance: true, signal: controller.signal })),
          ).rejects.toThrow("cancelled maintenance")
          expect(await store.read<{ retained: boolean }>([...prefix, "info"])).toEqual({ retained: true })
          expect(await store.snapshot((tx) => tx.artifact([...prefix, "artifacts", "256"]))).toBeDefined()
          await store.transaction((tx) =>
            tx.writeMany(
              Array.from({ length: 5000 }, (_, index) => ({
                key: [...prefix, "chunks", String(index)],
                value: { index },
              })),
            ),
          )
          expect(await store.transaction((tx) => tx.pruneTree(prefix, { maintenance: true }))).toBe(5001)
          expect(await store.list(prefix)).toEqual([])
          await expect(store.snapshot((tx) => tx.artifact([...prefix, "artifacts", "256"]))).rejects.toThrow()
          expect(await store.read<{ id: string }>(["sessions", "scope", "session", "info"])).toEqual({ id: "session" })
          expect((await store.verify()).issues).toEqual([])
        } finally {
          await store.close()
          await fs.rm(root, { recursive: true, force: true })
        }
      }),
    30_000,
  )
}
