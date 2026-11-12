import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { tmpdir } from "../support/fixture"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { WorkspacePortableTree as Portable } from "../../src/workspace/portable-tree"
import { WorkspaceContent, WorkspaceBlobs } from "../../src/workspace/content"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspaceTree } from "../../src/workspace/tree"
import { testRuntime } from "../support/runtime"

async function fixture(entries: AsyncIterable<Stream.Input>) {
  const objects = new Map<string, Uint8Array>()
  const bodies = new Set<string>()
  let bodyReads = 0
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      objects.set(hash, bytes.slice())
    },
    async get(hash: string, maximum: number) {
      if (bodies.has(hash)) bodyReads++
      const bytes = objects.get(hash)
      if (!bytes || bytes.byteLength > maximum) throw new Error("Missing or oversized Workspace object")
      return bytes.slice()
    },
  }
  const tree = await Stream.write({
    store,
    owners: { "workspace-files": 1 },
    entries: (async function* () {
      for await (const entry of entries) {
        const content = entry.content
        yield {
          ...entry,
          content: (async function* () {
            for await (const bytes of content) {
              bodies.add(createHash("sha256").update(bytes).digest("hex"))
              yield bytes
            }
          })(),
        }
      }
    })(),
  })
  return { store, root: { version: 1 as const, mode: 0o755, tree }, bodyReads: () => bodyReads }
}
const empty = async function* () {}

test("directory traversal preserves sibling files sorted before the descendant prefix", async () => {
  await using temporary = await tmpdir()
  const f = await fixture(
    (async function* (): AsyncGenerator<Stream.Input> {
      yield { id: "a", kind: "record", metadata: { version: 1, kind: "directory", mode: 0o755 }, content: empty() }
      for (const id of ["a.txt", "a/x"])
        yield { id, kind: "file", metadata: { version: 1, kind: "file", mode: 0o644 }, content: empty() }
    })(),
  )
  await using view = await Portable.open({ ...f, directory: temporary.path })
  expect((await Array.fromAsync(view.children(""))).map((entry) => entry.path)).toEqual(["a", "a.txt"])
  expect((await Array.fromAsync(view.children("a"))).map((entry) => entry.path)).toEqual(["a/x"])
  expect(f.bodyReads()).toBe(0)
})

test("paged children list immediate entries across pages without following links or reading bodies", async () => {
  await using temporary = await tmpdir()
  const f = await fixture(
    (async function* (): AsyncGenerator<Stream.Input> {
      for (const id of ["a", "a/sub", "a0", "a00", "目录"])
        yield { id, kind: "record", metadata: { version: 1, kind: "directory", mode: 0o750 }, content: empty() }
      for (let ordinal = 0; ordinal < 513; ordinal++)
        yield {
          id: `a/sub/file-${ordinal}`,
          kind: "file",
          metadata: { version: 1, kind: "file", mode: 0o640 },
          content: (async function* () {
            yield new Uint8Array([17])
          })(),
        }
      yield { id: "a/file", kind: "file", metadata: { version: 1, kind: "file", mode: 0o640 }, content: empty() }
      yield { id: "a/sub0", kind: "file", metadata: { version: 1, kind: "file", mode: 0o640 }, content: empty() }
      yield {
        id: "link",
        kind: "record",
        metadata: { version: 1, kind: "symlink", mode: 0o777, target: "a" },
        content: empty(),
      }
    })(),
  )
  await using view = await Portable.open({ ...f, directory: temporary.path })
  const names = async (directory: string) =>
    (await Array.fromAsync(view.children(directory))).map((entry) => entry.path)
  expect(await names("")).toEqual(["a", "a0", "a00", "link", "目录"])
  expect(await names("a")).toEqual(["a/file", "a/sub", "a/sub0"])
  expect(await names("a/sub")).toHaveLength(513)
  expect(await names("missing")).toEqual([])
  expect(await names("link")).toEqual([])
  expect(f.bodyReads()).toBe(0)
  const listing = view.children("")
  const first = await listing.next()
  if (first.done) throw new Error("Workspace has no first child")
  first.value.path = "目录"
  expect((await Array.fromAsync(listing)).map((entry) => entry.path)).toEqual(["a0", "a00", "link", "目录"])
  const escaped = view.children("")
  await view.close()
  await expect(escaped.next()).rejects.toThrow("closed")
})

test("late child cursors seek bounded metadata and retain their original directory and position", async () => {
  await using temporary = await tmpdir()
  const f = await fixture(
    (async function* (): AsyncGenerator<Stream.Input> {
      for (const id of ["a", "a/sub", "a0"])
        yield { id, kind: "record", metadata: { version: 1, kind: "directory", mode: 0o755 }, content: empty() }
      for (const id of ["a.txt", "a/sub.txt", "a0.txt", "z"])
        yield { id, kind: "file", metadata: { version: 1, kind: "file", mode: 0o644 }, content: empty() }
      for (let ordinal = 0; ordinal < 513; ordinal++)
        yield {
          id: `a/sub/file-${String(ordinal).padStart(4, "0")}`,
          kind: "file",
          metadata: { version: 1, kind: "file", mode: 0o644 },
          content: empty(),
        }
    })(),
  )
  await using view = await Portable.open({ ...f, directory: temporary.path })
  const parse = JSON.parse
  let decoded = 0
  using boundary = spyOn(JSON, "parse").mockImplementation((...args: Parameters<typeof JSON.parse>) => {
    const value: unknown = parse(...args)
    if (value && typeof value === "object" && typeof Reflect.get(value, "id") === "string") decoded++
    return value
  })
  const options = { after: "a" }
  const retained = view.children("", options)
  options.after = "z"
  expect((await retained.next()).value?.path).toBe("a.txt")
  await retained.return(undefined)
  const page = view.children("", { after: "a.txt" })
  decoded = 0
  expect((await page.next()).value?.path).toBe("a0")
  expect(decoded).toBeLessThanOrEqual(2)
  await page.return(undefined)
  decoded = 0
  const last = await Array.fromAsync(view.children("a/sub", { after: "a/sub/file-0510" }))
  expect(last.map((entry) => entry.path)).toEqual(["a/sub/file-0511", "a/sub/file-0512"])
  expect(decoded).toBeLessThanOrEqual(3)
  expect((await Array.fromAsync(view.children("a", { after: "a/sub" }))).map((entry) => entry.path)).toEqual([
    "a/sub.txt",
  ])
  expect(() => view.children("a", { after: "a/sub/file-0001" })).toThrow("another directory")
  expect(() => view.children("a", { after: "z" })).toThrow("another directory")
  expect(() => view.children("", { after: "../escape" })).toThrow()
  expect(f.bodyReads()).toBe(0)
})

test.each(["paged", "legacy"] as const)(
  "%s Workspace callbacks forward child cursors and retire their iterators",
  async (kind) => {
    const entries: WorkspaceTree.Entry[] = [
      { path: "a", kind: "directory", mode: 0o755 },
      ...["a.txt", "a/x"].map((path) => ({
        path,
        kind: "file" as const,
        mode: 0o644,
        size: 0,
        hash: WorkspaceTree.hash(new Uint8Array()),
        chunks: [],
      })),
    ]
    const f = await fixture(
      (async function* (): AsyncGenerator<Stream.Input> {
        for (const entry of entries) {
          const reference = Portable.reference(entry, empty())
          yield { ...reference, content: empty() }
        }
      })(),
    )
    const bytes =
      kind === "paged"
        ? new TextEncoder().encode(JSON.stringify(f.root))
        : WorkspaceTree.encode({ version: 1, entries })
    const manifest = WorkspaceTree.hash(bytes)
    await f.store.put(manifest, bytes)
    await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("children-fixture", f.store) })
    await runtime.run(async () => {
      const workspace = await WorkspaceCatalog.create({
        scopeID: "child-cursor-scope",
        backend: { provider: "objects", spec: { blobStore: "children-fixture" } },
      })
      const info = await WorkspaceCatalog.publishContent(workspace, manifest)
      let retained: AsyncIterator<Portable.Entry> | undefined
      await WorkspaceContent.withTree(info, f.store, async (tree) => {
        const options = { after: "a" }
        const page = tree.children("", options)
        options.after = "a.txt"
        expect((await Array.fromAsync(page)).map((entry) => entry.path)).toEqual(["a.txt"])
        expect(() => tree.children("a", { after: "a.txt" })).toThrow("another directory")
        retained = tree.children("", { after: "a" })
      })
      if (!retained) throw new Error("Workspace callback did not retain the child iterator")
      await expect(retained.next()).rejects.toThrow("ended")
      expect(f.bodyReads()).toBe(0)
    })
  },
)

test("paged Workspace metadata resolves directories and links without reading unrelated file content", async () => {
  await using temporary = await tmpdir()
  const f = await fixture(
    (async function* (): AsyncGenerator<Stream.Input> {
      for (let ordinal = 0; ordinal < 513; ordinal++)
        yield {
          id: `folder/file-${String(ordinal).padStart(4, "0")}`,
          kind: "file" as const,
          metadata: { version: 1, kind: "file", mode: 0o640 },
          content: (async function* () {
            yield new TextEncoder().encode(`content-${ordinal}`)
          })(),
        }
      yield {
        id: "link",
        kind: "record" as const,
        metadata: { version: 1, kind: "symlink", mode: 0o777, target: "folder" },
        content: empty(),
      }
      yield {
        id: "folder",
        kind: "record" as const,
        metadata: { version: 1, kind: "directory", mode: 0o750 },
        content: empty(),
      }
    })(),
  )
  await using view = await Portable.open({ ...f, directory: temporary.path })
  expect(f.bodyReads()).toBe(0)
  expect(await view.resolve("link/file-0512")).toEqual({
    path: "folder/file-0512",
    entry: {
      path: "folder/file-0512",
      kind: "file",
      mode: 0o640,
      size: 11,
      hash: createHash("sha256").update("content-512").digest("hex"),
    },
  })
  expect((await view.resolve("link", false)).entry?.kind).toBe("symlink")
  expect(await view.resolve("missing")).toEqual({ path: "missing", entry: undefined })
  const bytes: Uint8Array[] = []
  for await (const chunk of view.read("link/file-0512", { offset: 8, length: 3 })) bytes.push(chunk)
  expect(Buffer.concat(bytes).toString()).toBe("512")
  expect(f.bodyReads()).toBe(1)
  let count = 0
  for await (const _entry of view.entries({ prefix: "folder/" })) count++
  expect(count).toBe(513)
  await view.close()
  await expect(view.resolve("folder")).rejects.toThrow("closed")
})

test.each([
  { name: "absent parent", path: "missing/file", kind: "file", bytes: "private" },
  { name: "escaping link", path: "link", kind: "symlink", target: "../outside", bytes: "" },
  { name: "metadata payload", path: "folder", kind: "directory", bytes: "unexpected" },
] as const)("paged Workspace validation rejects $name before returning a file view", async (scenario) => {
  await using temporary = await tmpdir()
  const f = await fixture(
    (async function* (): AsyncGenerator<Stream.Input> {
      yield {
        id: scenario.path,
        kind: scenario.kind === "file" ? ("file" as const) : ("record" as const),
        metadata: {
          version: 1,
          kind: scenario.kind,
          mode: 0o755,
          ...("target" in scenario ? { target: scenario.target } : {}),
        },
        content: (async function* () {
          if (scenario.bytes) yield new TextEncoder().encode(scenario.bytes)
        })(),
      }
    })(),
  )
  await expect(Portable.open({ ...f, directory: temporary.path })).rejects.toThrow()
  expect(f.bodyReads()).toBe(0)
})
