import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { Storage } from "../../src/storage/storage"
import { convertLocalContent } from "../../src/storage/local-content"
import { storedAssets } from "../../src/asset/stored-assets"
import { StoredToolOutput } from "../../src/tool/stored-output"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { storedSnapshots } from "../../src/session/stored-snapshots"
import { StoragePath } from "../../src/storage/path"
import { SecretVault } from "../../src/secrets/vault"
import { encryptedSecretVault } from "../../src/secrets/encrypted-store"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "local-content-")))
  const runtime = await storageTestRuntime()
  const source = {
    store: await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "source.sqlite") }),
    ),
    artifactDirectory: path.join(root, "backup"),
  }
  const objects = new Map<string, Uint8Array>()
  let fail = false
  const target: Storage.Handle = {
    store: await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "target.sqlite") }),
    ),
    artifactDirectory: path.join(root, "fresh"),
    artifactObjects: {
      writerID: crypto.randomUUID(),
      blobs: {
        async put(key, bytes) {
          if (fail) throw new Error("synthetic unavailable")
          objects.set(key, bytes.slice())
        },
        async get(key) {
          const bytes = objects.get(key)
          if (!bytes) throw new Error("missing object")
          return bytes.slice()
        },
        async delete(key) {
          objects.delete(key)
        },
      },
    },
  }
  const keys = {
    async current() {
      return { version: "v1", key: Buffer.alloc(32, 11) }
    },
    async resolve() {
      return Buffer.alloc(32, 11)
    },
  }
  const options = {
    source,
    target,
    originalDataDirectory: "/previous-host/.synergy/data",
    authority: ["tenant", "profile"],
    keys,
    maxEntryBytes: 1024 * 1024,
    maxEntries: 1000,
    maxBytes: 16 * 1024 * 1024,
  }
  return {
    root,
    source,
    target,
    keys,
    objects,
    options,
    fail(value: boolean) {
      fail = value
    },
    run<T>(handle: Storage.Handle, body: () => Promise<T>) {
      return runtime.run(() => Storage.provide(handle, body))
    },
    convert() {
      return runtime.run(() => convertLocalContent(options))
    },
    async [Symbol.asyncDispose]() {
      await source.store.close()
      await target.store.close()
      await runtime.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("offline conversion preserves binary bytes, aliases and encrypted audit metadata after source deletion", async () => {
  await using f = await fixture()
  await f.run(f.source, () => Storage.writeBinary(["fixture", "binary"], Buffer.from("preserved binary")))
  const asset = Buffer.from("preserved asset")
  const id = createHash("sha256").update(asset).digest("hex").slice(0, 16) + ".txt"
  await fs.mkdir(path.join(f.source.artifactDirectory, "assets"), { recursive: true })
  await fs.writeFile(path.join(f.source.artifactDirectory, "assets", id), asset)
  const output = "Unicode output α😀\n".repeat(6000)
  await fs.mkdir(path.join(f.source.artifactDirectory, "tool-output"))
  await fs.writeFile(path.join(f.source.artifactDirectory, "tool-output/tool_history"), output)
  const value = "synthetic-conversion-secret"
  const secretID = SecretVault.idOf(value)
  const vault = {
    schemaVersion: 1,
    entries: {
      [secretID]: {
        id: secretID,
        value,
        fingerprint: { sha256: createHash("sha256").update(value).digest("hex"), length: value.length },
        source: { kind: "user" as const },
        policy: { tools: ["fixture"], maxResolvesPerSession: 2 },
        createdAt: 1,
        updatedAt: 2,
        resolvedCount: 1,
        history: [{ at: 2, sessionID: "session-one", tool: "fixture", outcome: "resolved" as const }],
      },
    },
  }
  await fs.mkdir(path.join(f.source.artifactDirectory, "auth"))
  await fs.writeFile(path.join(f.source.artifactDirectory, "auth/secret-vault.json"), JSON.stringify(vault))
  expect(await f.convert()).toMatchObject({ artifacts: 1, assets: 1, outputs: 1, secrets: 1 })
  expect(await f.convert()).toMatchObject({ artifacts: 1, assets: 1, outputs: 1, secrets: 1 })
  await fs.rm(f.source.artifactDirectory, { recursive: true })
  await fs.rm(f.target.artifactDirectory, { recursive: true, force: true })
  await f.run(f.target, async () => {
    expect(Buffer.from(await Storage.readBinary(["fixture", "binary"])).toString()).toBe("preserved binary")
    expect(Buffer.from((await storedAssets().read(id))!).toString()).toBe("preserved asset")
    expect(
      (await StoredToolOutput.read({ reference: "/previous-host/.synergy/data/tool-output/tool_history" })).text,
    ).toStartWith("Unicode output α😀")
    expect(await encryptedSecretVault({ authority: f.options.authority, keys: f.keys }).read()).toEqual(vault)
    expect(JSON.stringify(await Storage.read(["secrets", "encrypted-vault"]))).not.toContain(value)
  })
})

test("failed object write preserves the source and resumes without acknowledging unavailable data", async () => {
  await using f = await fixture()
  await f.run(f.source, () => Storage.writeBinary(["fixture", "binary"], Buffer.from("unchanged source")))
  f.fail(true)
  await expect(f.convert()).rejects.toThrow("synthetic unavailable")
  expect(Buffer.from(await f.run(f.source, () => Storage.readBinary(["fixture", "binary"]))).toString()).toBe(
    "unchanged source",
  )
  f.fail(false)
  expect((await f.convert()).artifacts).toBe(1)
  f.objects.clear()
  await expect(f.run(f.target, () => Storage.readBinary(["fixture", "binary"]))).rejects.toThrow()
})

test("conversion rejects links, malformed secrets, and byte limits", async () => {
  await using f = await fixture()
  await fs.mkdir(path.join(f.source.artifactDirectory, "assets"), { recursive: true })
  await fs.symlink("/etc/hosts", path.join(f.source.artifactDirectory, "assets/0000000000000000.txt"))
  await expect(f.convert()).rejects.toThrow("Unsupported local content entry")
  await fs.rm(path.join(f.source.artifactDirectory, "assets/0000000000000000.txt"))
  await fs.mkdir(path.join(f.source.artifactDirectory, "auth"))
  await fs.writeFile(
    path.join(f.source.artifactDirectory, "auth/secret-vault.json"),
    JSON.stringify({ schemaVersion: 1, entries: { broken: { value: "secret" } } }),
  )
  await expect(f.convert()).rejects.toThrow()
  await fs.rm(path.join(f.source.artifactDirectory, "auth"), { recursive: true })
  await f.run(f.source, () => Storage.writeBinary(["fixture", "large"], Buffer.alloc(300)))
  f.options.maxEntryBytes = 128
  await expect(f.convert()).rejects.toThrow("limits")
  expect(await f.target.store.query({ prefix: ["secrets"] })).toHaveLength(0)
})

for (const backend of ["legacy", "shared"] as const) {
  test(`${backend} snapshots retain original trees across conversion and an empty target cache`, async () => {
    await using f = await fixture()
    const scope = "home",
      session = "session-historical"
    const tree = await f.run(f.source, async () => {
      const repo =
        backend === "legacy" ? SnapshotStore.legacyRepository(scope, session) : SnapshotStore.repository(scope)
      await SnapshotStore.initializeBareRepository(repo)
      const blob = await SnapshotStore.command(
        repo,
        ["hash-object", "-w", "--stdin"],
        undefined,
        "retained snapshot text",
      )
      const tree = await SnapshotStore.command(repo, ["mktree"], undefined, `100644 blob ${blob}\tfile.txt\n`)
      await Storage.write(StoragePath.snapshotOwner(scope, session), { version: 2, backend })
      if (backend === "shared") await SnapshotStore.retainMany(scope, session, [tree])
      await Storage.write(["sessions", scope, session, "info"], { id: session })
      await Storage.write(["sessions", scope, session, "messages", "message", "parts", "part"], {
        type: "step-start",
        snapshot: tree,
      })
      return tree
    })
    for (const record of await f.source.store.query({ prefix: ["sessions"] }))
      await f.target.store.write(record.key, record.value)
    expect((await f.convert()).snapshots).toBe(1)
    expect((await f.convert()).snapshots).toBe(1)
    await fs.rm(f.source.artifactDirectory, { recursive: true })
    await fs.rm(f.target.artifactDirectory, { recursive: true, force: true })
    await f.run(f.target, async () => {
      const repo = SnapshotStore.repository(scope)
      expect(await storedSnapshots().restore(scope, session, [tree], repo)).toEqual(new Set([tree]))
      expect(await SnapshotStore.command(repo, ["show", `${tree}:file.txt`])).toBe("retained snapshot text")
      expect(await SnapshotStore.owner(scope, session)).toEqual({ version: 2, backend: "shared" })
    })
  }, 20_000)
}

test("a missing historical asset blocks conversion instead of silently activating broken history", async () => {
  await using f = await fixture()
  await f.source.store.write(["fixture", "file"], { url: "asset://0123456789abcdef.txt" })
  await expect(f.convert()).rejects.toThrow("no recoverable content")
})
