import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { Storage } from "../../src/storage/storage"
import { StorageCheckpoint } from "../../src/storage/checkpoint"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"
import type { StorageEntry } from "../../src/storage/portable"
import { SnapshotStore } from "../../src/session/snapshot-store"

async function fixture() {
  const runtime = await storageTestRuntime()
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "checkpoint-logical-"))
  const store = await TransactionalStore.open(
    storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "db") }),
  )
  const key = randomBytes(32)
  const keys = {
    async current() {
      return { version: "one", key }
    },
    async resolve() {
      return key
    },
  }
  const directory = path.join(root, "archive")
  const run = <T>(body: () => Promise<T>) =>
    runtime.run(() => Storage.provide({ store, artifactDirectory: path.join(root, "content") }, body))
  const manifest = await run(async () => {
    await Storage.write(
      ["snapshot-v2", "scope", "owners", "session"],
      SnapshotStore.Owner.parse({ version: 3, backend: "shared", retentionID: "retained" }),
    )
    await Storage.write(["sessions", "scope", "session", "parts", "part"], {
      body: "private protected Snapshot references",
      future: { preserved: true },
    })
    await Storage.writeBinary(["asset", "one"], new Uint8Array([0, 255, 1, 128]))
    return StorageCheckpoint.exportArchive({
      directory,
      archiveID: "logical",
      namespaceID: "source",
      buildVersion: "fixture",
      keys,
      protect: (entry) => entry.type === "record",
    })
  })
  return {
    root,
    directory,
    keys,
    manifest,
    run,
    async [Symbol.asyncDispose]() {
      key.fill(0)
      await store.close()
      await runtime.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("the canonical checkpoint entry port recovers protected logical owners and validates every native reference", async () => {
  await using f = await fixture()
  const entries: StorageEntry[] = []
  for await (const entry of StorageCheckpoint.entries({ directory: f.directory, keys: f.keys })) entries.push(entry)
  expect(entries.some((entry) => entry.type === "record" && entry.key[0] === "storage_checkpoint_secret")).toBe(false)
  expect(entries.find((entry) => entry.type === "record" && entry.key.includes("owners"))).toMatchObject({
    value: { version: 3, backend: "shared", retentionID: "retained" },
  })
  expect(entries.find((entry) => entry.type === "record" && entry.key[0] === "sessions")).toMatchObject({
    value: { body: "private protected Snapshot references", future: { preserved: true } },
  })
  const artifact = entries.find((entry) => entry.type === "artifact")
  if (!artifact || artifact.type !== "artifact") throw new Error("Expected a native binary reference")
  await fs.rm(path.join(f.directory, "objects", `${artifact.location.sha256}.bin`))
  await expect(
    (async () => {
      for await (const _entry of StorageCheckpoint.entries({ directory: f.directory, keys: f.keys })) {
      }
    })(),
  ).rejects.toThrow()
})

test("partial entry iteration, cancellation and unavailable recovery keys cannot complete capture verification", async () => {
  await using f = await fixture()
  let completed = false
  await expect(
    (async () => {
      for await (const _entry of StorageCheckpoint.entries({ directory: f.directory, keys: f.keys })) break
      completed = true
    })(),
  ).rejects.toThrow("complete")
  expect(completed).toBe(false)
  const controller = new AbortController()
  await expect(
    (async () => {
      for await (const _entry of StorageCheckpoint.entries({
        directory: f.directory,
        keys: f.keys,
        signal: controller.signal,
      }))
        controller.abort(new Error("Fixture capture cancelled"))
    })(),
  ).rejects.toThrow("capture cancelled")
  await expect(
    (async () => {
      for await (const _entry of StorageCheckpoint.entries({
        directory: f.directory,
        keys: {
          ...f.keys,
          async resolve() {
            throw new Error("Recovery key unavailable")
          },
        },
      })) {
      }
    })(),
  ).rejects.toThrow("key unavailable")
})

test("the logical entry port requires the original portable footer even when an outer descriptor is rewritten", async () => {
  await using f = await fixture()
  const filename = path.join(f.directory, "records.ndjson")
  const lines = (await Bun.file(filename).text()).trimEnd().split("\n")
  const truncated = lines.slice(0, -1).join("\n") + "\n"
  await Bun.write(filename, truncated)
  const manifestFile = path.join(f.directory, "manifest.json")
  const manifest = StorageCheckpoint.Manifest.parse(await Bun.file(manifestFile).json())
  await Bun.write(
    manifestFile,
    JSON.stringify({
      ...manifest,
      records: {
        ...manifest.records,
        bytes: Buffer.byteLength(truncated),
        sha256: createHash("sha256").update(truncated).digest("hex"),
      },
    }),
  )
  await expect(
    (async () => {
      for await (const _entry of StorageCheckpoint.entries({ directory: f.directory, keys: f.keys })) {
      }
    })(),
  ).rejects.toThrow("footer")
})

test("a capture is bound to its actual exported manifest when the directory is replaced by another valid archive", async () => {
  await using f = await fixture()
  const replacement = path.join(f.root, "replacement")
  await f.run(() =>
    StorageCheckpoint.exportArchive({
      directory: replacement,
      archiveID: "another-capture",
      namespaceID: "source",
      buildVersion: "fixture",
      keys: f.keys,
      protect: (entry) => entry.type === "record",
    }),
  )
  await fs.rename(f.directory, path.join(f.root, "original"))
  await fs.rename(replacement, f.directory)
  expect((await StorageCheckpoint.verifyArchive({ directory: f.directory, keys: f.keys })).archiveID).toBe(
    "another-capture",
  )
  await expect(
    (async () => {
      for await (const _entry of StorageCheckpoint.entries({
        directory: f.directory,
        keys: f.keys,
        expected: f.manifest,
      })) {
      }
    })(),
  ).rejects.toThrow("captured")
})
