import { AtomicFile } from "../../src/storage/atomic-file"
import { afterAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { StorageBootstrap } from "../../src/storage/bootstrap"
import { StoragePortable } from "../../src/storage/portable"

const fixtures = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "storage-bootstrap-"))
afterAll(() => fs.rm(fixtures, { recursive: true, force: true }))

async function home() {
  const root = path.join(fixtures, crypto.randomUUID(), ".synergy")
  await fs.mkdir(path.join(root, "data"), { recursive: true })
  return root
}

test("restored portable records report hashing and import before activation", async () => {
  const source = await StorageBootstrap.prepare({ root: await home() })
  const root = await home()
  try {
    await source.store.write(["notes", "scope", "archive"], { preserved: true })
    await source.store.transaction((tx) =>
      tx.writeArtifacts([
        {
          key: ["permissions", "untrusted"],
          location: {
            pack: "0".repeat(64) + ".pack",
            blockOffset: 0,
            blockBytes: 0,
            decodedBytes: 0,
            offset: 0,
            size: 0,
            codec: "raw",
            sha256: "0".repeat(64),
          },
        },
      ]),
    )
    await StoragePortable.exportFile(source.store, path.join(root, "data", "agent-records.ndjson"))
  } finally {
    await source.store.close()
  }
  const stages: string[] = []
  const restored = await StorageBootstrap.prepare({ root, progress: (value) => stages.push(value.stage) })
  try {
    expect(stages).toContain("archive-verify")
    expect(stages).toContain("archive-import")
    expect(await restored.store.snapshot(async (tx) => Array.fromAsync(tx.artifacts()))).toEqual([])
    expect(await restored.store.read<{ preserved: boolean }>(["notes", "scope", "archive"])).toEqual({
      preserved: true,
    })
    await restored.activate()
  } finally {
    await restored.store.close()
  }
})

test("keeps JSON intact until validation and activation and then uses only the database", async () => {
  const root = await home()
  const legacy = path.join(root, "data", "notes", "scope", "note.json")
  await fs.mkdir(path.dirname(legacy), { recursive: true })
  await Bun.write(legacy, JSON.stringify({ text: "retained" }))
  const prepared = await StorageBootstrap.prepare({ root })
  try {
    expect(prepared.manifest.phase).toBe("validating")
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await prepared.store.read<{ text: string }>(["notes", "scope", "note"])).toEqual({ text: "retained" })
    await prepared.activate()
    expect(await Bun.file(legacy).exists()).toBe(false)
    expect(prepared.manifest.phase).toBe("active")
  } finally {
    await prepared.store.close()
  }
  const reopened = await StorageBootstrap.prepare({ root })
  try {
    expect(reopened.manifest.phase).toBe("active")
    expect(await reopened.store.read<{ text: string }>(["notes", "scope", "note"])).toEqual({ text: "retained" })
  } finally {
    await reopened.store.close()
  }
})

test("does not recreate a missing active SQLite database", async () => {
  const root = await home()
  const prepared = await StorageBootstrap.prepare({ root })
  await prepared.activate()
  const filename = prepared.store.options.backend === "sqlite" ? prepared.store.options.filename : ""
  await prepared.store.close()
  await fs.unlink(filename)
  const failure = await StorageBootstrap.prepare({ root }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ name: "StorageIntegrityError" })
  expect(await Bun.file(filename).exists()).toBe(false)
})

test("resumes prepared data after a domain migration failure without opening task admission", async () => {
  const root = await home()
  const prepared = await StorageBootstrap.prepare({ root })
  await prepared.store.write(["domain", "checkpoint"], { done: true })
  await prepared.store.close()
  const resumed = await StorageBootstrap.prepare({ root })
  try {
    expect(resumed.manifest.phase).toBe("validating")
    expect(await resumed.store.read<{ done: boolean }>(["domain", "checkpoint"])).toEqual({ done: true })
    await resumed.activate()
  } finally {
    await resumed.store.close()
  }
})

test("rejects legacy records recreated by an old writer after activation", async () => {
  const root = await home()
  const prepared = await StorageBootstrap.prepare({ root })
  await prepared.activate()
  await prepared.store.close()
  await fs.mkdir(path.join(root, "data", "projects"), { recursive: true })
  await Bun.write(path.join(root, "data", "projects", "unexpected.json"), "{}")
  const failure = await StorageBootstrap.prepare({ root }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ name: "StorageIntegrityError" })
})

test.each([
  "data/channel/provider/account.json",
  "data/browser/sessions-v2/session.json",
  "data/push/subscriptions/device.json",
  "data/library/stats/info.json",
  "data/snapshot-v2/scope/owners/session.json",
  "data/sessions/scope/session/rollout/artifacts/artifact/chunks/000000000000.json",
  "plugin.lock",
])("active startup detects recreated legacy record %s", async (relative) => {
  const root = await home()
  const prepared = await StorageBootstrap.prepare({ root })
  await prepared.activate()
  await prepared.store.close()
  const filename = path.join(root, relative)
  await fs.mkdir(path.dirname(filename), { recursive: true })
  await Bun.write(filename, "{}")
  await expect(StorageBootstrap.prepare({ root })).rejects.toThrow("Legacy JSON records appeared")
})

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "active database startup does not require access to unrelated artifact trees",
  async () => {
    const root = await home()
    const artifacts = path.join(root, "data", "snapshot", "scope", "session")
    await fs.mkdir(artifacts, { recursive: true })
    await Bun.write(path.join(artifacts, "unrelated.json"), "{}")
    const prepared = await StorageBootstrap.prepare({ root })
    await prepared.activate()
    await prepared.store.close()
    await fs.chmod(path.join(root, "data", "snapshot"), 0)
    try {
      const reopened = await StorageBootstrap.prepare({ root })
      try {
        expect(reopened.manifest.phase).toBe("active")
      } finally {
        await reopened.store.close()
      }
    } finally {
      await fs.chmod(path.join(root, "data", "snapshot"), 0o700)
    }
  },
)

test("explicit target migration preserves data and switches configuration only after verification", async () => {
  const root = await home()
  const prepared = await StorageBootstrap.prepare({ root })
  await prepared.activate()
  await prepared.store.write(["notes", "scope", "note"], { value: "move me" })
  await StorageBootstrap.migrateTarget({
    root,
    store: prepared.store,
    configuration: { backend: "sqlite", filename: "data/storage/relocated.sqlite" },
  })
  await prepared.store.close()
  const moved = await StorageBootstrap.prepare({ root })
  try {
    expect(await moved.store.read<{ value: string }>(["notes", "scope", "note"])).toEqual({ value: "move me" })
    expect(moved.store.options).toMatchObject({
      backend: "sqlite",
      filename: path.join(root, "data/storage/relocated.sqlite"),
    })
  } finally {
    await moved.store.close()
  }
})

test("resumes a target switch interrupted between configuration and manifest activation", async () => {
  const root = await home()
  const prepared = await StorageBootstrap.prepare({ root })
  await prepared.activate()
  await prepared.store.write(["notes", "scope", "retained"], { value: 7 })
  const original = AtomicFile.writeJsonAtomic
  {
    using failure = spyOn(AtomicFile, "writeJsonAtomic").mockImplementation(async (filename, value, options) => {
      if (filename.endsWith("manifest.json")) throw new Error("activation interrupted")
      return original(filename, value, options)
    })
    await expect(
      StorageBootstrap.migrateTarget({
        root,
        store: prepared.store,
        configuration: { backend: "sqlite", filename: "data/storage/next.sqlite" },
      }),
    ).rejects.toThrow("activation interrupted")
  }
  await prepared.store.close()
  await expect(StorageBootstrap.prepare({ root })).rejects.toThrow("interrupted storage switch")
  expect(await StorageBootstrap.resumeTargetSwitch(root)).toBe(true)
  const resumed = await StorageBootstrap.prepare({ root })
  try {
    expect(await resumed.store.read<{ value: number }>(["notes", "scope", "retained"])).toEqual({ value: 7 })
  } finally {
    await resumed.store.close()
  }
})

test("activation verifies binary references before retiring legacy evidence", async () => {
  const root = await home()
  const key = ["sessions", "scope", "owner", "rollout", "blobs", "content"]
  const owner = path.join(root, "data", "sessions", "scope", "owner", "info.json")
  const binary = path.join(root, "data", ...key) + ".bin"
  await fs.mkdir(path.dirname(binary), { recursive: true })
  await Bun.write(
    owner,
    JSON.stringify({ id: "owner", title: "historical", scope: { id: "scope" }, time: { created: 1, updated: 2 } }),
  )
  await Bun.write(binary, "original bytes")
  const prepared = await StorageBootstrap.prepare({ root })
  try {
    const location = await prepared.store.snapshot((tx) => tx.artifact(key))
    await prepared.store.transaction((tx) =>
      tx.writeArtifacts([{ key, location: { ...location, sha256: "0".repeat(64) } }]),
    )
    await expect(prepared.activate()).rejects.toThrow("integrity")
    expect(await Bun.file(owner).exists()).toBe(true)
    expect(await Bun.file(binary).text()).toBe("original bytes")
    await prepared.store.transaction((tx) => tx.writeArtifacts([{ key, location }]))
    await prepared.activate()
    expect(await Bun.file(binary).exists()).toBe(false)
  } finally {
    await prepared.store.close()
  }
})
