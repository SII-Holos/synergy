import { expect, test } from "bun:test"
import { WorkspaceArchive } from "../../src/workspace/archive"
import { WorkspaceTree } from "../../src/workspace/tree"
import { WorkspaceContent, type BlobStore } from "../../src/workspace/content"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { RuntimeContext } from "../../src/lifecycle/context"

for (const format of ["legacy", "paged"] as const)
  test(`${format} Workspace verification is read-only without a Runtime and retains integrity and cancellation`, async () => {
    const objects = new Map<string, Uint8Array>()
    const store: BlobStore = {
      async put(hash, bytes) {
        objects.set(hash, bytes.slice())
      },
      async get(hash, maximum) {
        const bytes = objects.get(hash)
        if (!bytes || bytes.byteLength > maximum) throw new Error("Missing test object")
        return bytes.slice()
      },
    }
    const bytes = new Uint8Array([1, 2, 3]),
      hash = WorkspaceTree.hash(bytes)
    await store.put(hash, bytes)
    const tree: WorkspaceContent.StoredTree =
      format === "legacy"
        ? {
            version: 1,
            entries: [
              {
                kind: "file",
                path: "data.bin",
                mode: 0o640,
                size: bytes.byteLength,
                hash,
                chunks: [{ hash, size: bytes.byteLength }],
              },
            ],
          }
        : {
            version: 1,
            mode: 0o750,
            tree: await Stream.write({
              store,
              owners: { "workspace-files": 1 },
              entries: (async function* () {
                yield {
                  id: "data.bin",
                  kind: "file" as const,
                  metadata: { version: 1, kind: "file", mode: 0o640 },
                  content: (async function* () {
                    yield bytes
                  })(),
                }
              })(),
            }),
          }
    const encoded = "entries" in tree ? WorkspaceTree.encode(tree) : new TextEncoder().encode(JSON.stringify(tree))
    const manifest = WorkspaceTree.hash(encoded)
    await store.put(manifest, encoded)
    expect(RuntimeContext.tryCurrent()).toBeUndefined()
    const before = objects.size
    await WorkspaceArchive.verifyManifest({ manifest, source: { get: store.get.bind(store) } })
    expect(objects.size).toBe(before)
    objects.set(hash, new Uint8Array([9, 9, 9]))
    await expect(WorkspaceArchive.verifyManifest({ manifest, source: store })).rejects.toThrow("integrity")
    objects.set(hash, bytes)
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>()
    const controller = new AbortController(),
      reason = new Error("Pure archive verification cancelled during bytes")
    const verifying = WorkspaceArchive.verifyManifest({
      manifest,
      signal: controller.signal,
      source: {
        async get(selected, maximum) {
          const value = await store.get(selected, maximum)
          if (selected === hash) {
            entered.resolve()
            await resume.promise
          }
          return value
        },
      },
    })
    await entered.promise
    controller.abort(reason)
    resume.resolve()
    await expect(verifying).rejects.toBe(reason)
    expect(RuntimeContext.tryCurrent()).toBeUndefined()
  })
