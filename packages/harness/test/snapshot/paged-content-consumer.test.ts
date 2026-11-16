import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { SnapshotLink } from "../../src/session/snapshot-link"
import { storedSnapshots } from "../../src/session/stored-snapshots"
import type { SnapshotSchema } from "../../src/session/snapshot-schema"
import { ScopeContext } from "../../src/scope/context"
import { WorkspaceBlobs, type BlobStore } from "../../src/workspace/content"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspaceTree } from "../../src/workspace/tree"
import { WorkspacePortableTree as Portable } from "../../src/workspace/portable-tree"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { Storage } from "../../src/storage/storage"
import type { StoreTransaction, TransactionOptions } from "../../src/storage/transactional-store"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

async function fixture() {
  const temporary = await tmpdir({ git: true })
  const source = path.join(temporary.path, "object-source")
  await fs.mkdir(source)
  const requests: string[] = []
  const store: BlobStore = {
    async put(hash, bytes) {
      await fs.writeFile(path.join(source, hash), bytes)
    },
    async get(hash, maximum) {
      requests.push(hash)
      const bytes = await fs.readFile(path.join(source, hash))
      if (bytes.byteLength > maximum) throw new Error("Fixture object exceeds its frame")
      return bytes
    },
  }
  const runtime = await testRuntime({
    register() {
      WorkspaceBlobs.register("paged-snapshot", store)
      SnapshotStore.registerStorage(storedSnapshots())
    },
  })
  const run = <T>(body: () => Promise<T>) =>
    runtime.run(async () => ScopeContext.provide({ scope: await temporary.scope(), fn: body }))
  const content = new TextEncoder().encode("retained paged body\r\n")
  const bodyHash = WorkspaceTree.hash(content)
  const binary = new Uint8Array([0, 255, 17, 10])
  const large = new Uint8Array(2 * 1024 * 1024 + 1).fill(19)
  const root = await Stream.write({
    store,
    owners: { "workspace-files": 1 },
    entries: (async function* (): AsyncGenerator<Stream.Input> {
      const file = (id: string, bytes: Uint8Array, mode = 0o644): Stream.Input => ({
        id,
        kind: "file",
        metadata: { version: 1, kind: "file", mode },
        content: (async function* () {
          yield bytes
        })(),
      })
      yield file(".gitignore", new TextEncoder().encode("skip.txt\nignored/\n"))
      for (const name of ["ignored", "nested", "node_modules"])
        yield {
          id: name,
          kind: "record",
          metadata: { version: 1, kind: "directory", mode: 0o755 },
          content: (async function* () {})(),
        }
      yield file("nested/.gitignore", new TextEncoder().encode("*.tmp\n!keep.tmp\n"))
      yield file("nested/keep.tmp", content)
      yield file("nested/skip.tmp", content)
      yield file("ignored/file.txt", content)
      yield file("node_modules/private.txt", content)
      yield file("skip.txt", content)
      yield file("large.txt", large)
      yield file("binary.dat", binary)
      yield {
        id: "link",
        kind: "record",
        metadata: { version: 1, kind: "symlink", mode: 0o777, target: "nested/keep.tmp" },
        content: (async function* () {})(),
      }
      for (let index = 0; index < 270; index++)
        yield file(`nested/file-${String(index).padStart(3, "0")}.txt`, content, index === 0 ? 0o755 : 0o644)
    })(),
  })
  const tree = Portable.Root.parse({ version: 1, mode: 0o755, tree: root })
  const encoded = new TextEncoder().encode(JSON.stringify(tree))
  const manifest = WorkspaceTree.hash(encoded)
  await store.put(manifest, encoded)
  const info = await run(async () => {
    const info = await WorkspaceCatalog.create({
      scopeID: ScopeContext.current.scope.id,
      backend: { provider: "objects", spec: { blobStore: "paged-snapshot" } },
    })
    return WorkspaceCatalog.publishContent(info, manifest)
  })
  return {
    run,
    source,
    store,
    info,
    root,
    manifest,
    content,
    bodyHash,
    binary,
    largeHash: WorkspaceTree.hash(large),
    requests,
    async [Symbol.asyncDispose]() {
      await runtime.close()
      await temporary[Symbol.asyncDispose]()
    },
  }
}

test("paged object heads retain bounded Snapshot content, ignore rules and links after source and Git cache loss", async () => {
  await using f = await fixture()
  expect(f.root.pages).toBeGreaterThan(1)
  await f.run(async () => {
    const original = WorkspaceTree.Manifest.parse({
      version: 1,
      entries: [
        {
          path: "skip.txt",
          kind: "file",
          mode: 0o644,
          size: f.content.length,
          hash: f.bodyHash,
          chunks: [{ hash: f.bodyHash, size: f.content.length }],
        },
      ],
    })
    const encoded = WorkspaceTree.encode(original)
    const manifest = WorkspaceTree.hash(encoded)
    await f.store.put(manifest, encoded)
    const baseline = await WorkspaceCatalog.publishContent(f.info, manifest)
    await Snapshot.trackContent(baseline, manifest, "paged-content")
    const selected = await WorkspaceCatalog.publishContent(baseline, f.manifest)
    const omissions: SnapshotSchema.Omission[] = []
    const root = await Snapshot.trackContent(selected, f.manifest, "paged-content", undefined, (items) =>
      omissions.push(...items),
    )
    expect(omissions).toEqual([{ file: "large.txt", reason: "size_limit" }])
    expect(f.requests).not.toContain(f.largeHash)
    const repository = SnapshotStore.repository(f.info.scopeID)
    const listing = await SnapshotStore.command(repository, ["ls-tree", "-r", "--name-only", root])
    const names = listing.split("\n")
    expect(names).toHaveLength(276)
    expect(names).toContain("skip.txt")
    for (const name of ["ignored/file.txt", "nested/skip.tmp", "node_modules/private.txt", "large.txt"])
      expect(names).not.toContain(name)
    expect(await SnapshotStore.command(repository, ["ls-tree", root, "nested/file-000.txt"])).toStartWith("100755")
    await fs.rm(f.source, { recursive: true, force: true })
    await fs.rm(repository, { recursive: true, force: true })
    expect(await SnapshotStore.owns(f.info.scopeID, "paged-content", root)).toBe(true)
    const show = (name: string) =>
      SnapshotGit.run(["git", "--git-dir", repository, "show", `${root}:${name}`], path.dirname(repository))
    expect((await show("nested/file-269.txt")).bytes).toEqual(f.content)
    expect((await show("binary.dat")).bytes).toEqual(f.binary)
    expect(SnapshotLink.decode((await show("link")).bytes)).toEqual({ target: "nested/keep.tmp" })
  })
}, 20_000)

test("missing immutable object bytes cannot become Snapshot omissions or publish a root", async () => {
  await using f = await fixture()
  await fs.rm(path.join(f.source, f.bodyHash))
  await f.run(async () => {
    let omissions = 0
    await expect(
      Snapshot.trackContent(f.info, f.manifest, "missing-content", undefined, () => omissions++),
    ).rejects.toThrow()
    expect(omissions).toBe(0)
    expect(await Array.fromAsync(SnapshotStore.roots(f.info.scopeID, "missing-content"))).toEqual([])
  })
})

test("verified chunks with a wrong complete-file digest cannot publish a Snapshot root", async () => {
  await using f = await fixture()
  const linked = await Stream.link({
    store: f.store,
    owners: { "workspace-files": 1 },
    entries: (async function* () {
      yield {
        id: "file.txt",
        kind: "file" as const,
        metadata: { version: 1, kind: "file", mode: 0o644 },
        bytes: f.content.length,
        hash: "0".repeat(64),
        chunks: (async function* () {
          yield { hash: f.bodyHash, bytes: f.content.length }
        })(),
      }
    })(),
  })
  const tree = Portable.Root.parse({ version: 1, mode: 0o755, tree: linked })
  const encoded = new TextEncoder().encode(JSON.stringify(tree))
  const manifest = WorkspaceTree.hash(encoded)
  await f.store.put(manifest, encoded)
  await f.run(async () => {
    let omissions = 0
    await expect(
      Snapshot.trackContent(f.info, manifest, "wrong-file-hash", undefined, () => omissions++),
    ).rejects.toThrow("checksum")
    expect(omissions).toBe(0)
    expect(await Array.fromAsync(SnapshotStore.roots(f.info.scopeID, "wrong-file-hash"))).toEqual([])
  })
})

test("a held paged source retains its originally selected Workspace and saved head", async () => {
  await using f = await fixture()
  const scopeID = f.info.scopeID
  const get = f.store.get.bind(f.store)
  const began = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  f.store.get = async (hash, maximum) => {
    const bytes = await get(hash, maximum)
    if (hash === f.manifest) {
      began.resolve()
      await released.promise
    }
    return bytes
  }
  await f.run(async () => {
    const pending = Snapshot.trackContent(f.info, f.manifest, "original-head", undefined, () => {})
    void pending.catch(() => {})
    await began.promise
    f.info.scopeID = "foreign-scope"
    f.info.id = "foreign-workspace"
    f.info.binding.generation++
    f.info.content!.manifest = "0".repeat(64)
    released.resolve()
    const root = await pending
    expect(await SnapshotStore.owns(scopeID, "original-head", root)).toBe(true)
    expect(
      await SnapshotStore.command(SnapshotStore.repository(scopeID), ["show", `${root}:nested/file-269.txt`]),
    ).toBe(new TextDecoder().decode(f.content).trim())
  })
})

test("a cancelled original object read drains without publishing a Snapshot root", async () => {
  await using f = await fixture()
  const get = f.store.get.bind(f.store)
  const began = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const controller = new AbortController()
  const reason = new Error("Original paged Snapshot cancelled")
  let entered = false
  f.store.get = async (hash, maximum) => {
    const bytes = await get(hash, maximum)
    if (hash === f.bodyHash) {
      entered = true
      began.resolve()
      await released.promise
    }
    return bytes
  }
  await f.run(async () => {
    const pending = Snapshot.trackContent(f.info, f.manifest, "cancelled-content", controller.signal)
    void pending.catch(() => {})
    const rescue = setTimeout(() => began.resolve(), 2_000)
    try {
      await began.promise
      expect(entered).toBe(true)
      controller.abort(reason)
      released.resolve()
      await expect(pending).rejects.toBe(reason)
      expect(await Array.fromAsync(SnapshotStore.roots(f.info.scopeID, "cancelled-content"))).toEqual([])
    } finally {
      clearTimeout(rescue)
      released.resolve()
      await pending.catch(() => {})
    }
  })
})

test("an original artifact owner cannot be replaced during a held paged Snapshot read", async () => {
  await using f = await fixture()
  const get = f.store.get.bind(f.store)
  const began = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  f.store.get = async (hash, maximum) => {
    const bytes = await get(hash, maximum)
    if (hash === f.bodyHash) {
      began.resolve()
      await released.promise
    }
    return bytes
  }
  await f.run(async () => {
    const owner = Storage.current()
    const original = owner.artifactDirectory
    const pending = Snapshot.trackContent(f.info, f.manifest, "replaced-owner", undefined, () => {})
    void pending.catch(() => {})
    try {
      await began.promise
      owner.artifactDirectory = path.join(original, "replaced")
      released.resolve()
      await expect(pending).rejects.toThrow("Store or artifact configuration")
    } finally {
      owner.artifactDirectory = original
      released.resolve()
      await pending.catch(() => {})
    }
    expect(await Array.fromAsync(SnapshotStore.roots(f.info.scopeID, "replaced-owner"))).toEqual([])
  })
})

test("a completed Git tree cannot publish Snapshot retention after its original artifact owner changes", async () => {
  await using f = await fixture()
  const began = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const run = SnapshotGit.run
  using held = spyOn(SnapshotGit, "run").mockImplementation(async (...args) => {
    const result = await run(...args)
    if (args[0].includes("write-tree")) {
      began.resolve()
      await released.promise
    }
    return result
  })
  await f.run(async () => {
    const owner = Storage.current()
    const original = owner.artifactDirectory
    const pending = Snapshot.trackContent(f.info, f.manifest, "late-owner", undefined, () => {})
    void pending.catch(() => {})
    try {
      await began.promise
      owner.artifactDirectory = path.join(original, "replaced-after-tree")
      released.resolve()
      await expect(pending).rejects.toThrow()
    } finally {
      owner.artifactDirectory = original
      released.resolve()
      await pending.catch(() => {})
    }
    expect(await Array.fromAsync(SnapshotStore.roots(f.info.scopeID, "late-owner"))).toEqual([])
  })
})

test("the actual stored Snapshot COMMIT rejects an artifact owner change after its last publication write", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const owner = Storage.current()
    const original = owner.artifactDirectory
    const transaction = owner.store.transaction.bind(owner.store)
    let changed = false
    using fault = spyOn(owner.store, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) =>
        transaction(async (tx) => {
          const write = tx.write.bind(tx)
          let manifest = false
          tx.write = async (...args) => {
            const result = await write(...args)
            const key = args[0]
            if (key[0] === "snapshot-v2" && key[2] === "content" && key.at(-1) === "manifest") manifest = true
            return result
          }
          try {
            const result = await body(tx)
            if (manifest) {
              changed = true
              owner.artifactDirectory = path.join(original, "replaced-at-commit")
            }
            return result
          } finally {
            tx.write = write
          }
        }, options),
    )
    try {
      await expect(Snapshot.trackContent(f.info, f.manifest, "commit-owner", undefined, () => {})).rejects.toThrow(
        "Store or artifact configuration",
      )
      expect(changed).toBe(true)
    } finally {
      owner.artifactDirectory = original
    }
    expect(await Array.fromAsync(SnapshotStore.roots(f.info.scopeID, "commit-owner"))).toEqual([])
    expect(
      await Storage.queryKeys({ prefix: ["snapshot-v2", f.info.scopeID, "content", "commit-owner"], limit: 1 }),
    ).toEqual([])
    expect(
      await Storage.queryKeys({ prefix: ["stored_snapshot_preparation", f.info.scopeID, "commit-owner"], limit: 1 }),
    ).toHaveLength(1)
  })
})
