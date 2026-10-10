import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { storedSnapshots } from "../../src/session/stored-snapshots"
import { SnapshotLifecycle } from "../../src/session/snapshot-lifecycle"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "stored-snapshots-"))
  const options = storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "db") })
  let store = await TransactionalStore.open(options)
  let runtime = await storageTestRuntime()
  const objects = new Map<string, Uint8Array>()
  let failed = false
  let onUpload: (() => void) | undefined
  runtime.run(() => SnapshotStore.registerStorage(storedSnapshots()))
  const handle = {
    store,
    artifactDirectory: path.join(root, "cache"),
    artifactObjects: {
      writerID: "writer",
      blobs: {
        async put(id: string, value: Uint8Array) {
          if (failed) throw new Error("object service unavailable")
          objects.set(id, value)
          onUpload?.()
        },
        async get(id: string) {
          const value = objects.get(id)
          if (!value) throw new Error("object missing")
          return value
        },
        async delete(id: string) {
          objects.delete(id)
        },
      },
    },
  }
  const run = <T>(body: () => Promise<T>) => runtime.run(() => Storage.provide(handle, body))
  const scope = "scope-snapshots"
  const session = "session-original"
  const capture = (text: string, target = session, signal?: AbortSignal) =>
    run(async () => {
      const operation = await SnapshotStore.resolveRepository(scope, target)
      await SnapshotStore.initialize(operation)
      const blob = await SnapshotStore.command(operation.repository, ["hash-object", "-w", "--stdin"], undefined, text)
      const tree = await SnapshotStore.command(
        operation.repository,
        ["mktree"],
        undefined,
        `100644 blob ${blob}\tfile.txt\n`,
      )
      await SnapshotStore.retainMany(scope, target, [tree], signal)
      return tree
    })
  return {
    root,
    handle,
    objects,
    scope,
    session,
    run,
    capture,
    failUploads() {
      failed = true
    },
    onUpload(fn: () => void) {
      onUpload = fn
    },
    async reopen(external = true) {
      await runtime.close()
      await store.close()
      await fs.rm(handle.artifactDirectory, { recursive: true, force: true })
      runtime = await storageTestRuntime()
      store = await TransactionalStore.open(options)
      handle.store = store
      handle.artifactDirectory = path.join(root, crypto.randomUUID())
      if (external) runtime.run(() => SnapshotStore.registerStorage(storedSnapshots()))
    },
    async [Symbol.asyncDispose]() {
      await runtime.close()
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("snapshot history and fork ownership survive deletion of every local Git cache", async () => {
  await using f = await fixture()
  const before = await f.capture("before")
  const after = await f.capture("after")
  await f.reopen()
  await f.run(async () => {
    expect(await SnapshotStore.owns(f.scope, "unrelated-session", before)).toBe(false)
    expect(await SnapshotStore.ownsMany(f.scope, f.session, [before, after])).toEqual(new Set([before, after]))
    const repo = SnapshotStore.repository(f.scope)
    expect(await SnapshotStore.command(repo, ["show", `${before}:file.txt`])).toBe("before")
    expect(await SnapshotStore.command(repo, ["diff", before, after])).toContain("+after")
    await SnapshotLifecycle.adopt({
      scopeID: f.scope,
      sourceSessionID: f.session,
      targetSessionID: "session-fork",
      hashes: [before, after],
    })
    await SnapshotLifecycle.beginDelete(f.scope, f.session)
    await Storage.removeTree(["sessions", f.scope, f.session])
    await fs.rm(f.handle.artifactDirectory, { recursive: true, force: true })
    expect(await SnapshotStore.owns(f.scope, f.session, before)).toBe(false)
    expect(await SnapshotStore.owns(f.scope, "session-fork", before)).toBe(true)
    expect(await SnapshotStore.command(repo, ["show", `${before}:file.txt`])).toBe("before")
  })
})

test.each(["pack", "blob"] as const)(
  "snapshot ownership repairs a retained reference with a missing %s",
  async (lost) => {
    await using f = await fixture()
    const hash = await f.capture("durable historical content")
    if (lost === "pack") await f.reopen()
    await f.run(async () => {
      expect(await SnapshotStore.owns(f.scope, f.session, hash)).toBe(true)
      const repo = SnapshotStore.repository(f.scope)
      if (lost === "pack") {
        const directory = path.join(repo, "objects", "pack")
        for (const file of await fs.readdir(directory)) await fs.rm(path.join(directory, file))
      } else {
        const blob = await SnapshotStore.command(repo, ["rev-parse", `${hash}:file.txt`])
        await fs.rm(path.join(repo, "objects", blob.slice(0, 2), blob.slice(2)))
      }
      expect(await SnapshotStore.command(repo, ["rev-parse", SnapshotStore.reference(f.session, hash)])).toBe(hash)
      expect(await SnapshotStore.owns(f.scope, f.session, hash)).toBe(true)
      expect(await SnapshotStore.command(repo, ["show", `${hash}:file.txt`])).toBe("durable historical content")
    })
  },
)

test("failed snapshot upload never grants ownership from an uncommitted local reference", async () => {
  await using f = await fixture()
  f.failUploads()
  await expect(f.capture("unpublished")).rejects.toThrow("object service unavailable")
  await f.run(async () => {
    const repo = SnapshotStore.repository(f.scope)
    const hash = await SnapshotStore.command(repo, ["for-each-ref", "--format=%(objectname)"])
    expect(hash).toMatch(/^[a-f0-9]{40}$/)
    expect(await SnapshotStore.owns(f.scope, f.session, hash)).toBe(false)
    expect(
      await SnapshotLifecycle.adopt({
        scopeID: f.scope,
        sourceSessionID: f.session,
        targetSessionID: "cannot-recover-unpublished",
        hashes: [hash],
        allowMissing: true,
      }),
    ).toEqual({ missing: [hash] })
  })
})

test("activated snapshot storage cannot silently switch backends", async () => {
  await using f = await fixture()
  const root = await f.capture("retained")
  await f.reopen(false)
  await f.run(async () => {
    await expect(SnapshotStore.owns(f.scope, f.session, root)).rejects.toThrow("activated format")
    await expect(SnapshotStore.initializeRepository(f.scope)).rejects.toThrow("activated format")
    await Storage.write(StoragePath.snapshotRepository(f.scope), { version: 2, objectFormat: "sha1" })
  })
  await f.reopen()
  await f.run(async () => {
    await expect(SnapshotStore.initializeRepository(f.scope)).rejects.toThrow("offline migration")
  })
})

test("missing remote snapshot content fails closed after cache loss", async () => {
  await using f = await fixture()
  const hash = await f.capture("retained")
  await fs.rm(f.handle.artifactDirectory, { recursive: true, force: true })
  f.objects.clear()
  await f.run(async () => {
    await expect(SnapshotStore.owns(f.scope, f.session, hash)).rejects.toThrow("object missing")
    expect(await Storage.read(["sessions", f.scope, f.session, "snapshot_content", hash, "manifest"])).toBeDefined()
  })
})

test("corrupt snapshot chunks are rejected without publishing local ownership", async () => {
  await using f = await fixture()
  const hash = await f.capture("retained")
  await f.reopen()
  let corrupted = false
  for (const [key, bytes] of f.objects) {
    if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "PACK") continue
    const changed = bytes.slice()
    changed[changed.length - 1] ^= 1
    f.objects.set(key, changed)
    corrupted = true
  }
  expect(corrupted).toBe(true)
  await f.run(async () => {
    await expect(SnapshotStore.owns(f.scope, f.session, hash)).rejects.toThrow()
    const refs = await SnapshotStore.command(SnapshotStore.repository(f.scope), ["for-each-ref", "--format=%(refname)"])
    expect(refs).toBe("")
  })
})

test("multi-chunk snapshot capture is bounded and cancellation cannot publish a partial root", async () => {
  await using f = await fixture()
  const value = randomBytes(5 * 1024 * 1024).toString("base64")
  const root = await f.capture(value)
  await f.reopen()
  await f.run(async () => {
    const manifest = await Storage.read<{ packs: { chunks: unknown[] }[] }>([
      "sessions",
      f.scope,
      f.session,
      "snapshot_content",
      root,
      "manifest",
    ])
    expect(manifest.packs.flatMap((pack) => pack.chunks).length).toBeGreaterThan(1)
    expect(await SnapshotStore.owns(f.scope, f.session, root)).toBe(true)
    expect(await SnapshotStore.command(SnapshotStore.repository(f.scope), ["show", `${root}:file.txt`])).toBe(value)
  })
  const abort = new AbortController()
  f.onUpload(() => abort.abort(new Error("capture cancelled")))
  await expect(f.capture(value, "session-cancelled", abort.signal)).rejects.toThrow("capture cancelled")
  await f.run(async () => {
    expect(await Storage.list(["sessions", f.scope, "session-cancelled", "snapshot_content"])).toEqual([])
    expect(await SnapshotStore.owns(f.scope, "session-cancelled", root)).toBe(false)
  })
})
