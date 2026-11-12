import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import { mkdirSync, renameSync, statSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { WorkspacePortableTree } from "@ericsanchezok/synergy-harness/workspace/portable-tree"
import type { BlobStore } from "@ericsanchezok/synergy-harness/storage/blobs"
import { NativeWorkspacePortableTree } from "../../src/workspace/portable-tree"
import { NativeWorkspaceTree } from "../../src/workspace/tree"
import { MountReceipt, NativeWorkspaceFiles } from "../../src/workspace/file-host"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { createHash } from "node:crypto"
import { FileRename } from "../../src/file/rename"

async function fixture() {
  const temporary = await tmpdir()
  const source = path.join(temporary.path, "source")
  const objects = path.join(temporary.path, "source-objects")
  await fs.mkdir(path.join(source, "entry", "empty"), { recursive: true })
  await fs.mkdir(objects)
  for (let index = 0; index < 260; index++)
    await fs.writeFile(
      path.join(source, "entry", `file-${index.toString().padStart(3, "0")}.dat`),
      new Uint8Array([0, 255, index % 251]),
    )
  await fs.chmod(path.join(source, "entry", "file-000.dat"), 0o755)
  if (process.platform !== "win32") await fs.symlink("file-000.dat", path.join(source, "entry", "link"))
  const sourceStore: BlobStore = {
    async put(hash, bytes) {
      await fs.writeFile(path.join(objects, hash), bytes)
    },
    async get(hash, maximum) {
      const bytes = await fs.readFile(path.join(objects, hash))
      if (bytes.length > maximum) throw new Error("Fixture object exceeds its frame")
      return bytes
    },
  }
  const options = {
    directory: path.join(temporary.path, "receipts"),
    materializationRoot: path.join(temporary.path, "views"),
    coordinator: new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") }),
    ...(process.getuid && process.getgid ? { owner: { uid: process.getuid(), gid: process.getgid() } } : {}),
  }
  const host = new NativeWorkspaceFiles(options)
  let root: WorkspacePortableTree.Root
  await using runtime = await testRuntime()
  root = await runtime.run(() =>
    NativeWorkspacePortableTree.capture({
      root: source,
      directory: path.join(temporary.path, "capture"),
      store: sourceStore,
    }),
  )
  await using reader = await WorkspacePortableTree.open({ root, store: sourceStore, directory: temporary.path })
  for await (const object of reader.objects())
    await host.putBlob(object.hash, await sourceStore.get(object.hash, object.bytes))
  const bytes = new TextEncoder().encode(JSON.stringify(root))
  const manifest = WorkspaceTree.hash(bytes)
  await host.putBlob(manifest, bytes)
  await fs.rm(source, { recursive: true, force: true })
  await fs.rm(objects, { recursive: true, force: true })
  const reference = { id: "paged-mount", workspaceID: "workspace", generation: 1 }
  const mount = { ...reference, readOnly: false, source: { kind: "materialized" as const, manifest } }
  return {
    host,
    options,
    root,
    manifest,
    reference,
    mount,
    directory: temporary.path,
    async [Symbol.asyncDispose]() {
      await host.close()
      await temporary[Symbol.asyncDispose]()
    },
  }
}

test("FileHost materializes a multi-page saved head after all source files and objects disappear", async () => {
  await using f = await fixture()
  expect(f.root.tree.pages).toBeGreaterThan(1)
  const mounted = await f.host.mount(f.mount)
  expect(await fs.readFile(path.join(mounted.path, "entry", "file-259.dat"))).toEqual(Buffer.from([0, 255, 259 % 251]))
  expect((await fs.stat(path.join(mounted.path, "entry", "empty"))).isDirectory()).toBe(true)
  if (process.platform !== "win32") {
    expect(await fs.readlink(path.join(mounted.path, "entry", "link"))).toBe("file-000.dat")
    const file = await fs.stat(path.join(mounted.path, "entry", "file-000.dat"))
    expect(file.mode & 0o777).toBe(0o755)
    expect(file.uid).toBe(process.getuid!())
    expect(file.gid).toBe(process.getgid!())
  }
  await f.host.close()
  const cold = new NativeWorkspaceFiles(f.options)
  try {
    expect(await cold.mount(f.mount)).toEqual(mounted)
    expect((await cold.read({ mount: f.reference, path: "entry/file-259.dat", maximumBytes: 16 })).data).toBe(
      Buffer.from([0, 255, 259 % 251]).toString("base64"),
    )
  } finally {
    await cold.close()
  }
}, 15_000)

test("FileHost imports a paged entry subtree through its original native mutation receipt", async () => {
  await using f = await fixture()
  const directory = path.join(f.directory, "target")
  await fs.mkdir(directory)
  const mount = await f.host.mount({
    ...f.reference,
    id: "directory-mount",
    source: { kind: "directory", path: directory },
    readOnly: false,
  })
  const input = { id: "paged-import", mount, change: { kind: "import" as const, to: "imported", manifest: f.manifest } }
  const checkpoint = await f.host.mutate(input)
  expect(await f.host.mutate(input)).toEqual(checkpoint)
  expect((await f.host.checkpointStatus(input.id))?.state).toBe("saved")
  expect(await fs.readFile(path.join(directory, "imported", "file-259.dat"))).toEqual(Buffer.from([0, 255, 259 % 251]))
  if (process.platform !== "win32")
    expect(await fs.readlink(path.join(directory, "imported", "link"))).toBe("file-000.dat")
  await f.host.acknowledge(input.id)
  expect((await f.host.checkpointStatus(input.id))?.state).toBe("released")
}, 15_000)

for (const replace of [false, true])
  test(`a paged native preparation ${replace ? "rejects an equal-content foreign directory" : "reconciles a lost native rename acknowledgement"}`, async () => {
    await using f = await fixture()
    const root = path.join(f.options.materializationRoot, createHash("sha256").update(f.mount.id).digest("hex"))
    const rename = FileRename.exclusive
    let lost = false
    using publication = spyOn(FileRename, "exclusive").mockImplementation((...args) => {
      rename(...args)
      if (!lost && String(args[1]) === root) {
        lost = true
        throw new Error("Native directory publication acknowledgement lost")
      }
    })
    await expect(f.host.mount(f.mount)).rejects.toThrow("Native directory publication acknowledgement lost")
    expect(lost).toBe(true)
    expect(await f.host.inspect(f.reference)).toBeUndefined()
    await f.host.close()
    if (replace) {
      await fs.rename(root, root + "-original")
      await fs.cp(root + "-original", root, { recursive: true, preserveTimestamps: true })
    }
    const cold = new NativeWorkspaceFiles(f.options)
    try {
      if (replace) {
        await expect(cold.mount(f.mount)).rejects.toThrow("original native preparation")
        expect(await cold.inspect(f.reference)).toBeUndefined()
      } else {
        const mount = await cold.mount(f.mount)
        expect(mount.path).toBe(root)
        expect(await fs.readFile(path.join(root, "entry", "file-259.dat"))).toEqual(Buffer.from([0, 255, 259 % 251]))
      }
    } finally {
      await cold.close()
    }
  }, 15_000)

test("paged materialization retains its original blob methods and native owner options", async () => {
  await using f = await fixture()
  const get = f.host.getBlob.bind(f.host)
  const began = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const body = WorkspaceTree.hash(new Uint8Array([0, 255, 0]))
  let entered = false
  f.host.getBlob = async (hash, maximum) => {
    const bytes = await get(hash, maximum)
    if (!entered && hash === body) {
      entered = true
      began.resolve()
      await released.promise
    }
    return bytes
  }
  const pending = f.host.mount(f.mount)
  void pending.catch(() => {})
  try {
    await began.promise
    f.host.getBlob = async () => {
      throw new Error("Replacement blob method must not run")
    }
    f.options.directory = path.join(f.directory, "different-receipts")
    f.options.materializationRoot = path.join(f.directory, "different-views")
    if (f.options.owner) f.options.owner.uid = Number.NaN
    released.resolve()
    const mounted = await pending
    expect(mounted.path.startsWith(path.join(f.directory, "views"))).toBe(true)
    expect(await fs.readFile(path.join(mounted.path, "entry", "file-259.dat"))).toEqual(
      Buffer.from([0, 255, 259 % 251]),
    )
    expect(await f.host.inspect(f.reference)).toEqual(mounted)
  } finally {
    released.resolve()
    await pending.catch(() => {})
  }
}, 15_000)

test("FileHost shutdown drains an accepted paged read without publishing a mount receipt or directory", async () => {
  await using f = await fixture()
  const get = f.host.getBlob.bind(f.host)
  const began = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const body = WorkspaceTree.hash(new Uint8Array([0, 255, 0]))
  f.host.getBlob = async (hash, maximum) => {
    const bytes = await get(hash, maximum)
    if (hash === body) {
      began.resolve()
      await released.promise
    }
    return bytes
  }
  const pending = f.host.mount(f.mount)
  void pending.catch(() => {})
  let closing: Promise<void> | undefined
  try {
    await began.promise
    closing = f.host.close()
    released.resolve()
    await expect(pending).rejects.toThrow("Workspace file host is closing")
    await closing
    expect(await f.host.inspect(f.reference)).toBeUndefined()
    expect(await fs.readdir(f.options.materializationRoot)).toEqual([])
  } finally {
    released.resolve()
    await pending.catch(() => {})
    await closing
  }
}, 15_000)

for (const after of [false, true])
  test(`a native publication rejects a foreign empty directory ${after ? "after its rename" : "after its final identity check"}`, async () => {
    await using f = await fixture()
    const root = path.join(f.options.materializationRoot, createHash("sha256").update(f.mount.id).digest("hex"))
    const rename = FileRename.exclusive
    let replacement: number | undefined
    const replace = () => {
      if (after) renameSync(root, root + "-original")
      mkdirSync(root)
      replacement = statSync(root).ino
    }
    using publication = spyOn(FileRename, "exclusive").mockImplementation((...args) => {
      if (!after && String(args[1]) === root) replace()
      rename(...args)
      if (after && String(args[1]) === root) replace()
    })
    await expect(f.host.mount(f.mount)).rejects.toThrow()
    if (replacement === undefined) throw new Error("Native publication barrier did not run")
    expect((await fs.stat(root)).ino).toBe(replacement)
    expect(await fs.readdir(root)).toEqual([])
    expect(await f.host.inspect(f.reference)).toBeUndefined()
  }, 15_000)

test("legacy native preparations retain original identity and reject missing or foreign preparation evidence", async () => {
  for (const mode of ["original", "foreign", "missing"] as const) {
    await using temporary = await tmpdir()
    const options = {
      directory: path.join(temporary.path, "receipts"),
      materializationRoot: path.join(temporary.path, "views"),
      coordinator: new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") }),
    }
    const host = new NativeWorkspaceFiles(options)
    const bytes = WorkspaceTree.encode({ version: 1, entries: [] })
    const manifest = WorkspaceTree.hash(bytes)
    await host.putBlob(manifest, bytes)
    const input = {
      id: "legacy",
      workspaceID: "workspace",
      generation: 1,
      readOnly: false,
      source: { kind: "materialized" as const, manifest },
    }
    const key = createHash("sha256").update(input.id).digest("hex")
    const root = path.join(options.materializationRoot, key)
    const rename = FileRename.exclusive
    let lost = false
    using publication = spyOn(FileRename, "exclusive").mockImplementation((...args) => {
      rename(...args)
      if (!lost && String(args[1]) === root) {
        lost = true
        throw new Error("Legacy native acknowledgement lost")
      }
    })
    try {
      await expect(host.mount(input)).rejects.toThrow("Legacy native acknowledgement lost")
    } finally {
      await host.close()
    }
    if (mode === "foreign") {
      await fs.rename(root, root + "-original")
      await fs.mkdir(root)
    }
    if (mode === "missing") {
      const receipt = path.join(options.directory, "mounts", key)
      const old = MountReceipt.parse(await Bun.file(receipt).json())
      delete old.preparedPhysicalID
      await fs.writeFile(receipt, JSON.stringify(old))
    }
    const cold = new NativeWorkspaceFiles(options)
    try {
      if (mode === "original") expect((await cold.mount(input)).path).toBe(root)
      else {
        await expect(cold.mount(input)).rejects.toThrow("original native preparation")
        expect(await cold.inspect(input)).toBeUndefined()
        const pending = MountReceipt.parse(await Bun.file(path.join(options.directory, "mounts", key)).json())
        expect(pending.mount).toBeUndefined()
      }
    } finally {
      await cold.close()
    }
  }
}, 15_000)

test("missing immutable paged bytes never publish a native mount", async () => {
  await using f = await fixture()
  const body = WorkspaceTree.hash(new Uint8Array([0, 255, 0]))
  const key = createHash("sha256").update(body).digest("hex")
  await fs.rm(path.join(f.options.directory, "blobs", key))
  await expect(f.host.mount(f.mount)).rejects.toThrow()
  expect(await f.host.inspect(f.reference)).toBeUndefined()
  expect(await fs.readdir(f.options.materializationRoot)).toEqual([])
}, 15_000)

for (const format of ["legacy", "paged"] as const)
  test(`${format} materialization preserves an existing empty destination without retiring it`, async () => {
    await using f = await fixture()
    const target = path.join(f.directory, "existing")
    await fs.mkdir(target)
    const original = (await fs.stat(target)).ino
    const rmdir = fs.rmdir.bind(fs)
    let replacement: number | undefined
    using retirement = spyOn(fs, "rmdir").mockImplementation(async (directory, options) => {
      if (String(directory) === target) {
        await fs.rename(target, target + "-original")
        await fs.mkdir(target)
        replacement = (await fs.stat(target)).ino
      }
      return rmdir(directory, options)
    })
    const store = { put: f.host.putBlob.bind(f.host), get: f.host.getBlob.bind(f.host) }
    const operation =
      format === "legacy"
        ? NativeWorkspaceTree.materialize(target, { version: 1, entries: [] }, store)
        : NativeWorkspacePortableTree.materialize({
            root: target,
            captured: f.root,
            store,
            directory: path.join(f.directory, "existing-cache"),
          })
    await expect(operation).rejects.toThrow()
    expect(replacement).toBeUndefined()
    expect((await fs.stat(target)).ino).toBe(original)
    expect(await fs.readdir(target)).toEqual([])
  }, 15_000)
