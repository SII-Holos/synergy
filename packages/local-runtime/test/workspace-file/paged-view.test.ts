import { expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceBlobs, type BlobStore } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { WorkspacePortableTree as Portable } from "@ericsanchezok/synergy-harness/workspace/portable-tree"
import { SessionTransferStream as Stream } from "@ericsanchezok/synergy-harness/session/transfer"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { FileView } from "../../src/file/view"
import { testRuntime } from "../support/runtime"

test("selected dormant paged files browse, observe and read one immutable tree without compute", async () => {
  const data = new Uint8Array(9 * 1024 * 1024 + 17).fill(7)
  data.fill(13, 4 * 1024 * 1024)
  const unused = new Uint8Array([91, 92, 93])
  const unusedHash = WorkspaceTree.hash(unused)
  const reads: string[] = []
  const store: BlobStore = {
    put: (hash, bytes) => Storage.writeBinary(["paged-fixture", hash], bytes),
    get(hash) {
      reads.push(hash)
      return Storage.readBinary(["paged-fixture", hash])
    },
  }
  let host: ReturnType<typeof EnvironmentOrigin.registerHost> | undefined
  await using runtime = await testRuntime({
    register() {
      WorkspaceBlobs.register("paged-fixture", store)
      host = EnvironmentOrigin.registerHost("paged-view-fixture")
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root: Portable.Root = {
          version: 1,
          mode: 0o750,
          tree: await Stream.write({
            store,
            owners: { "workspace-files": 1 },
            entries: (async function* (): AsyncGenerator<Stream.Input> {
              for (const id of ["dir", "dir/deep"])
                yield {
                  id,
                  kind: "record",
                  metadata: { version: 1, kind: "directory", mode: 0o750 },
                  content: (async function* () {
                    yield* []
                  })(),
                }
              for (const id of ["alias", "link"])
                yield {
                  id,
                  kind: "record",
                  metadata: { version: 1, kind: "symlink", mode: 0o777, target: id === "alias" ? "dir" : "dir/file" },
                  content: (async function* () {
                    yield* []
                  })(),
                }
              yield {
                id: "dir/file",
                kind: "file",
                metadata: { version: 1, kind: "file", mode: 0o640 },
                content: (async function* () {
                  yield data
                })(),
              }
              for (let index = 0; index < 257; index++)
                yield {
                  id: `dir/deep/unrelated-${index}`,
                  kind: "file",
                  metadata: { version: 1, kind: "file", mode: 0o600 },
                  content: (async function* () {
                    yield unused
                  })(),
                }
            })(),
          }),
        }
        const encoded = new TextEncoder().encode(JSON.stringify(root))
        const hash = WorkspaceTree.hash(encoded)
        await store.put(hash, encoded)
        const initial = await WorkspaceCatalog.create({
          scopeID: Scope.home().id,
          backend: { provider: "objects", spec: { blobStore: "paged-fixture" } },
        })
        const workspace = await WorkspaceCatalog.publishContent(initial, hash)
        if (!host) throw new Error("Fixture host was not registered")
        await using resources = await EnvironmentResources.resolve({
          scopeID: workspace.scopeID,
          workspaceID: workspace.id,
          needs: { workspace: true },
          origin: host.capture("browse"),
        })
        await EnvironmentResources.provide(resources, "browse", async () => {
          reads.length = 0
          expect(await FileView.canonical("alias/file")).toBe("dir/file")
          expect(await FileView.stat("link")).toMatchObject({ kind: "symlink", size: 0 })
          const file = await FileView.stat("link", true)
          expect(file).toMatchObject({ path: "link", kind: "file", size: data.length, mode: 0o640 })
          expect(await FileView.stat("")).toMatchObject({ kind: "directory", mode: 0o750 })
          expect((await FileView.list("alias")).map(({ path }) => path)).toEqual(["alias/deep", "alias/file"])
          expect(reads.includes(unusedHash)).toBe(false)
          expect(reads.includes(WorkspaceTree.hash(data.subarray(0, Stream.chunkBytes)))).toBe(false)
          expect(await FileView.bytes("link", { offset: 1, length: 5 * 1024 * 1024 })).toEqual(
            data.subarray(1, 5 * 1024 * 1024 + 1),
          )
          const observed = await FileView.observe("alias/file")
          expect(observed.canonical).toBe("dir/file")
          expect(observed.bytes).toEqual(data)
          expect(observed.entry?.entryVersion).toBe((await FileView.stat("alias/file"))?.entryVersion)
          expect((await FileView.revalidate("alias/file", observed)).fingerprint).toBe(observed.fingerprint)
          expect(await FileView.bytes("link", { offset: Number.MAX_SAFE_INTEGER, length: 4 })).toHaveLength(0)
          const range = { offset: 1, length: 3 }
          const reading = FileView.bytes("link", range)
          range.offset = data.length - 3
          expect(await reading).toEqual(data.subarray(1, 4))
          expect(reads.includes(unusedHash)).toBe(false)
          expect(await Storage.queryKeys({ prefix: ["environment"], limit: 1 })).toEqual([])
        })
      },
    }),
  )
}, 30000)
