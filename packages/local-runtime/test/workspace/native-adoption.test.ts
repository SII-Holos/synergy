import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { NativeWorkspacePortableTree } from "../../src/workspace/portable-tree"
import { testRuntime, testWorkspaceCoordinator } from "../support/runtime"
import { upgradeAccessRecord } from "@ericsanchezok/synergy-harness/migration/import"
import type { StoreTransaction, TransactionOptions } from "@ericsanchezok/synergy-harness/storage/transactional-store"

test("existing native adoption compares the complete source and target, reconfirms changed targets, and retains its original claim through publication", async () => {
  await using temporary = await tmpdir()
  const sourceDirectory = path.join(temporary.path, "source")
  const targetDirectory = path.join(temporary.path, "target")
  const objects = path.join(temporary.path, "objects")
  for (const directory of [sourceDirectory, targetDirectory, objects]) await fs.mkdir(directory)
  for (let index = 0; index < 300; index++) {
    const name = `file-${String(index).padStart(4, "0")}`
    await Bun.write(path.join(sourceDirectory, name), `source-${index}`)
    await Bun.write(path.join(targetDirectory, name), `target-${index}`)
  }
  let reads = 0
  const store = {
    put: async (hash: string, bytes: Uint8Array) => {
      await Bun.write(path.join(objects, hash), bytes)
    },
    get: (hash: string) => {
      reads++
      return Bun.file(path.join(objects, hash)).bytes()
    },
  }
  await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("native-adoption", store) })
  await runtime.run(async () => {
    const files = await NativeWorkspacePortableTree.capture({
      root: sourceDirectory,
      directory: path.join(temporary.path, "capture"),
      store,
    })
    const bytes = new TextEncoder().encode(JSON.stringify(files))
    const manifest = WorkspaceTree.hash(bytes)
    await store.put(manifest, bytes)
    const source = await WorkspaceCatalog.create({
      scopeID: "home",
      backend: { provider: "objects", spec: { blobStore: "native-adoption" } },
    })
    const imported = await WorkspaceContent.prepareTreeImport(
      { workspaceID: source.id, scopeID: source.scopeID },
      { path: "selected", manifest },
    )
    const published = await Storage.transaction(() => imported.publish())
    const saved = await WorkspaceArchive.saved({
      workspaceID: source.id,
      scopeID: source.scopeID,
      expectedRevision: published.revision,
    })
    const snapshot = await WorkspaceArchive.subtree(saved, "selected")
    const target = await WorkspaceBinding.register("home", targetDirectory)
    const request = {
      kind: "native-adoption" as const,
      id: "same-native-move",
      source: { workspaceID: source.id, scopeID: source.scopeID, generation: source.binding.generation },
      target: {
        workspaceID: target.id,
        scopeID: target.scopeID,
        generation: target.binding.generation,
        path: "" as const,
        expectedRevision: target.revision,
      },
      sourceSnapshotHash: WorkspaceArchive.subtreeHash(snapshot),
      mappingRevision: 1,
      actor: {
        kind: "local" as const,
        subjectID: "fixture",
        displayName: "Fixture",
        clientKind: "cli" as const,
        requestID: "same-native-move",
      },
    }
    const assert = WorkspaceContent.captureOwner()
    const input = {
      source: {
        snapshot,
        store,
        assert,
        async recheck() {
          assert()
          const current = await WorkspaceArchive.saved({
            workspaceID: source.id,
            scopeID: source.scopeID,
            expectedRevision: published.revision,
          })
          if (
            WorkspaceArchive.subtreeHash(await WorkspaceArchive.subtree(current, "selected")) !==
            request.sourceSnapshotHash
          )
            throw new Error("Source changed")
          assert()
        },
      },
      store,
    }
    const preview = await WorkspaceMove.previewNative(request, input)
    expect(preview.entries).toBe(300)
    let cursor: string | undefined
    let count = 0
    const beforePages = reads
    do {
      const page = await WorkspaceMove.nativeDifference(request, {
        expectedRevision: preview.diffHash,
        cursor,
        limit: 64,
      })
      expect(page.diffHash).toBe(preview.diffHash)
      count += page.items.length
      cursor = page.cursor
    } while (cursor)
    expect(count).toBe(300)
    expect(reads).toBe(beforePages)
    await expect(
      WorkspaceMove.nativeDifference(request, { expectedRevision: "0".repeat(64), limit: 64 }),
    ).rejects.toThrow("changed")
    await Bun.write(path.join(targetDirectory, "file-0299"), "new target version")
    await expect(WorkspaceMove.prepareNative(request, { ...input, consent: preview })).rejects.toThrow("changed")
    const updated = await WorkspaceMove.previewNative(request, input)
    expect(updated.targetDigest).not.toBe(preview.targetDigest)
    expect(updated.diffHash).not.toBe(preview.diffHash)
    const receipt = await WorkspaceMove.prepareNative(request, { ...input, consent: updated })
    expect(receipt).toMatchObject({
      id: request.id,
      sourceSnapshotHash: request.sourceSnapshotHash,
      acceptedDiffHash: updated.diffHash,
      outcome: "adopted-target-version",
      target: { workspaceID: target.id, generation: target.binding.generation, revision: target.revision },
    })
    expect(
      (await testWorkspaceCoordinator().inspect()).some((claim) => claim.durable && claim.kind === "exclusive"),
    ).toBe(true)
    let releasedBeforeOuterRollback = false
    const rolledBack = await Storage.transaction(async () => {
      await WorkspaceMove.release(request, "retired")
      releasedBeforeOuterRollback = !(await testWorkspaceCoordinator().inspect()).some(
        (claim) => claim.durable && claim.kind === "exclusive" && claim.state === "active",
      )
      throw new Error("Outer native publication rollback")
    }).catch((error) => error)
    expect(await WorkspaceMove.inspect(request)).toMatchObject({ state: "published", nativeRequested: true })
    expect(releasedBeforeOuterRollback).toBe(false)
    expect(
      (await testWorkspaceCoordinator().inspect()).some(
        (claim) => claim.durable && claim.kind === "exclusive" && claim.state === "active",
      ),
    ).toBe(true)
    expect(rolledBack).toMatchObject({ data: { message: expect.stringContaining("outside") } })
    await expect(
      Storage.transaction(() => WorkspaceMove.withNativePublication(request, receipt, async () => {})),
    ).rejects.toThrow("outside")
    const stopped = new AbortController()
    await expect(
      WorkspaceMove.withNativePublication(
        request,
        receipt,
        () =>
          Storage.transaction(
            async () => {
              await WorkspaceMove.publishNative(request, receipt)
              await Storage.write(["test-native-adoption", request.id], {
                receipt: WorkspaceMove.nativeReceiptHash(receipt),
              })
              stopped.abort()
            },
            { commitGuard: () => WorkspaceMove.assertNativePublication(request, receipt) },
          ),
        stopped.signal,
      ),
    ).rejects.toThrow()
    expect((await Storage.readMany([["test-native-adoption", request.id]]))[0]).toBeUndefined()
    await WorkspaceMove.withNativePublication(request, receipt, async () =>
      Storage.transaction(
        async () => {
          await WorkspaceMove.publishNative(request, receipt)
          await Storage.write(["test-native-adoption", request.id], {
            receipt: WorkspaceMove.nativeReceiptHash(receipt),
          })
        },
        { commitGuard: () => WorkspaceMove.assertNativePublication(request, receipt) },
      ),
    )
    await expect(WorkspaceMove.release(request, "cancelled")).rejects.toThrow("permanent outcome")
    expect(await WorkspaceMove.inspect(request)).toMatchObject({
      state: "published",
      nativePublication: WorkspaceMove.nativeReceiptHash(receipt),
    })
    await WorkspaceMove.release(request, "activated")
    expect(
      (await testWorkspaceCoordinator().inspect()).some(
        (claim) => claim.durable && claim.kind === "exclusive" && claim.state === "active",
      ),
    ).toBe(false)
    expect(await Bun.file(path.join(targetDirectory, "file-0299")).text()).toBe("new target version")
    expect(await Bun.file(path.join(targetDirectory, "file-0000")).text()).toBe("target-0")
    const cancelledRequest = { ...request, id: "cancel-native-publication" }
    const cancelledPreview = await WorkspaceMove.previewNative(cancelledRequest, input)
    const cancelledReceipt = await WorkspaceMove.prepareNative(cancelledRequest, {
      ...input,
      consent: cancelledPreview,
    })
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>(),
      terminal = Promise.withResolvers<void>()
    const selected = Storage.current().store,
      transaction = selected.transaction.bind(selected)
    using decision = spyOn(selected, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
        let cancelled = false
        const result = await transaction(async (tx) => {
          const write = tx.write.bind(tx)
          tx.write = async (...args) => {
            await write(...args)
            const [key, value] = args
            if (
              key[0] === "workspace_move" &&
              key.at(-1) === cancelledRequest.id &&
              value &&
              typeof value === "object" &&
              "state" in value &&
              value.state === "cancelled"
            )
              cancelled = true
          }
          try {
            return await body(tx)
          } finally {
            tx.write = write
          }
        }, options)
        if (cancelled) {
          terminal.resolve()
          throw new Error("Lost terminal commit acknowledgement")
        }
        return result
      },
    )
    const publication = WorkspaceMove.withNativePublication(cancelledRequest, cancelledReceipt, async () => {
      entered.resolve()
      await resume.promise
      return Storage.transaction(
        async () => {
          await WorkspaceMove.publishNative(cancelledRequest, cancelledReceipt)
          await Storage.write(["test-native-adoption", cancelledRequest.id], { late: true })
        },
        {
          commitGuard: () => WorkspaceMove.assertNativePublication(cancelledRequest, cancelledReceipt),
        },
      )
    })
    void publication.catch(() => {})
    await entered.promise
    const releasing = WorkspaceMove.release(cancelledRequest, "cancelled")
    void releasing.catch(() => {})
    try {
      await Promise.race([terminal.promise, releasing])
      expect((await WorkspaceMove.inspect(cancelledRequest))?.state).toBe("cancelled")
      resume.resolve()
      await expect(publication).rejects.toThrow("reservation")
      await expect(releasing).rejects.toThrow("Lost terminal commit acknowledgement")
      expect(await WorkspaceMove.inspect(cancelledRequest)).toMatchObject({ state: "cancelled", nativeRequested: true })
      decision.mockRestore()
      await WorkspaceMove.release(cancelledRequest, "cancelled")
      expect((await Storage.readMany([["test-native-adoption", cancelledRequest.id]]))[0]).toBeUndefined()
      expect(
        (await testWorkspaceCoordinator().inspect()).some(
          (claim) => claim.durable && claim.kind === "exclusive" && claim.state === "active",
        ),
      ).toBe(false)
    } finally {
      resume.resolve()
      await Promise.allSettled([publication, releasing])
    }
  })
}, 20_000)

test("native adoption's owning migration preserves version-one object move identities and rejects corrupt or unknown records", async () => {
  await using temporary = await tmpdir()
  const directory = path.join(temporary.path, "directory")
  await fs.mkdir(directory)
  await Bun.write(path.join(directory, "value"), "retained source")
  await using runtime = await testRuntime({
    register: () =>
      WorkspaceBlobs.register("move-upgrade", {
        put: (hash, bytes) => Storage.writeBinary(["move-upgrade", hash], bytes),
        get: (hash) => Storage.readBinary(["move-upgrade", hash]),
      }),
  })
  await runtime.run(async () => {
    const source = await WorkspaceBinding.register("home", directory)
    const target = await WorkspaceCatalog.create({
      scopeID: "home",
      backend: { provider: "objects", spec: { blobStore: "move-upgrade" } },
    })
    const request = {
      id: "legacy-object",
      source: { workspaceID: source.id, scopeID: source.scopeID, generation: source.binding.generation },
      target: {
        workspaceID: target.id,
        scopeID: target.scopeID,
        generation: target.binding.generation,
        path: "received",
        expectedRevision: target.revision,
      },
      mappingRevision: 1,
      acceptedDiffHash: null,
      actor: {
        kind: "local" as const,
        subjectID: "fixture",
        displayName: "Fixture",
        clientKind: "cli" as const,
        requestID: "legacy-object",
      },
    }
    const key = ["workspace_move", target.scopeID, request.id]
    const old = {
      version: 1,
      digest: WorkspaceMove.requestHash(request),
      request,
      state: "preparing",
      nativeRequested: false,
    }
    await Storage.transaction(async () => {
      await Storage.write(key, old)
      await Storage.write(["workspace_move_active", target.scopeID, target.id, request.id], request)
    })
    expect(upgradeAccessRecord(key, old)).toMatchObject({ version: 2, digest: old.digest, request })
    expect(await WorkspaceMove.inspect(request)).toMatchObject({ version: 1, digest: old.digest, request })
    const receipt = await WorkspaceMove.run(request)
    expect(receipt).toMatchObject({ version: 1, requestHash: old.digest })
    expect(
      await WorkspaceMove.requestForTarget({ id: request.id, workspaceID: target.id, scopeID: target.scopeID }),
    ).toEqual(request)
    await expect(
      WorkspaceMove.requestForTarget({ id: request.id, workspaceID: "another-workspace", scopeID: target.scopeID }),
    ).rejects.toThrow("original target")
    expect(await WorkspaceContent.read({ workspaceID: target.id, scopeID: target.scopeID }, "received/value")).toEqual(
      Buffer.from("retained source"),
    )
    await WorkspaceMove.release(request, "activated")
    const valid = await Storage.read<Record<string, unknown>>(key)
    try {
      await Storage.write(key, { ...old, preview: {} })
      await expect(WorkspaceMove.inspect(request)).rejects.toThrow()
      await Storage.write(key, { ...valid, version: 99 })
      await expect(WorkspaceMove.inspect(request)).rejects.toThrow()
      await Storage.write(key, { ...valid, snapshot: {} })
      await expect(WorkspaceMove.inspect(request)).rejects.toThrow()
    } finally {
      await Storage.write(key, valid)
    }
  })
})
