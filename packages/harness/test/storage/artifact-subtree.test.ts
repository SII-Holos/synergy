import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestBackends } from "../support/storage-backends"
import { storageTestRuntime } from "../support/storage-runtime"
import { createV2Store } from "./format-v3-fixture"

const runtime = await storageTestRuntime()
afterAll(() => runtime.close())

const location = {
  pack: "00000000-0000-0000-0000-000000000000.pack",
  codec: "raw" as const,
  blockOffset: 0,
  blockBytes: 1,
  decodedBytes: 1,
  offset: 0,
  size: 1,
  sha256: "0".repeat(64),
}

const segments = [
  "part",
  "PART",
  "part-sibling",
  "p%_!",
  'p"quoted',
  "p\\",
  "p,]",
  "汉字",
  "é",
  "e\u0301",
  "😀",
  "\0\n",
  "\ud800",
]
const owner = ["sessions", "scope", "session"]
const keys = [
  ["blobs"],
  ["blobs", "one"],
  owner,
  ...segments.flatMap((segment) => [
    [...owner, segment],
    [...owner, segment, "child"],
    [...owner, segment, "child", "grandchild"],
    [...owner, segment + "-neighbor", "child"],
  ]),
  ["sessions", "scope", "another", "part"],
  ["sessions", "other", "session", "part"],
  ["operations", "scope", "session", "part"],
]

function sorted(keys: string[][]) {
  return keys.map((key) => JSON.stringify(key)).sort()
}

for (const backend of storageTestBackends()) {
  for (const format of backend === "sqlite" ? [2, 3] : [2]) {
    test(
      `${backend} format ${format} artifact subtrees preserve segment identity, budgets and atomic collection`,
      () =>
        runtime.run(async () => {
          const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "artifact-subtree-"))
          const filename = path.join(root, "agent.sqlite")
          const namespace = crypto.randomUUID()
          if (backend === "sqlite" && format === 2) createV2Store({ filename, namespace, records: [] })
          const store = await TransactionalStore.open(
            backend === "sqlite"
              ? { backend, filename, namespace }
              : { backend, namespace, url: process.env.SYNERGY_TEST_POSTGRES_URL! },
          )
          const prefixes = [
            [],
            ["blobs"],
            ["sessions"],
            ["sessions", "scope"],
            owner,
            ...segments.map((s) => [...owner, s]),
            [...owner, "missing"],
          ]
          const limits = { records: 100, nodes: 100, artifacts: 0 }
          const rollback = new Error("roll back subtree cleanup")
          const all = sorted(keys)
          try {
            await store.transaction((tx) => tx.writeArtifacts(keys.map((key) => ({ key, location }))))
            // The same keys in another namespace must survive even a root removal.
            await store.transaction((tx) =>
              tx.raw.query(
                "INSERT INTO storage_artifacts(namespace, key_text, owner_key, location" +
                  (backend === "postgres" || format === 2 ? ", pack" : "") +
                  ") SELECT ?, key_text, owner_key, location" +
                  (backend === "postgres" || format === 2 ? ", pack" : "") +
                  " FROM storage_artifacts WHERE namespace = ?",
                [namespace + "-foreign", namespace],
              ),
            )
            for (const prefix of prefixes) {
              const matched = keys.filter((key) => prefix.every((segment, index) => key[index] === segment))
              const retained = keys.filter((key) => !prefix.every((segment, index) => key[index] === segment))
              expect(
                sorted(
                  await store.snapshot(async (tx) =>
                    Array.fromAsync(tx.artifacts(prefix)).then((rows) => rows.map((row) => row.key)),
                  ),
                ),
              ).toEqual(sorted(matched))
              for (const budget of [Math.max(0, matched.length - 1), matched.length]) {
                expect(
                  await store.snapshot((tx) =>
                    tx.pruneDeferral(prefix, { ...limits, artifacts: budget }, Date.now() + 60_000),
                  ),
                ).toBe(matched.length > budget ? "artifacts" : undefined)
              }
              for (const operation of prefix.length
                ? (["removeTree", "pruneTree"] as const)
                : (["removeTree"] as const)) {
                await expect(
                  store.transaction(async (tx) => {
                    await tx[operation](prefix)
                    expect(sorted((await Array.fromAsync(tx.artifacts())).map((row) => row.key))).toEqual(
                      sorted(retained),
                    )
                    expect(await tx.artifactGarbage()).toEqual(
                      matched.length ? [{ pack: location.pack, used: retained.length > 0 }] : [],
                    )
                    throw rollback
                  }),
                ).rejects.toBe(rollback)
                expect(
                  sorted(
                    await store.snapshot(async (tx) => (await Array.fromAsync(tx.artifacts())).map((row) => row.key)),
                  ),
                ).toEqual(all)
                expect(await store.snapshot((tx) => tx.artifactGarbage())).toEqual([])
              }
            }
            await store.removeTree([...owner, "part"])
            expect(await store.snapshot((tx) => tx.artifactGarbage())).toEqual([{ pack: location.pack, used: true }])
            await store.removeTree([])
            expect(await store.snapshot((tx) => tx.artifactGarbage())).toEqual([{ pack: location.pack, used: false }])
            const [foreign] = await store.snapshot((tx) =>
              tx.raw.query("SELECT COUNT(*) AS count FROM storage_artifacts WHERE namespace = ?", [
                namespace + "-foreign",
              ]),
            )
            expect(Number(foreign?.count)).toBe(keys.length)
          } finally {
            await store.transaction((tx) =>
              tx.raw.query("DELETE FROM storage_artifacts WHERE namespace = ?", [namespace + "-foreign"]),
            )
            await store.close()
            await fs.rm(root, { recursive: true, force: true })
          }
        }),
      30_000,
    )
  }
}
