import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { upgradeAccessRecord } from "@ericsanchezok/synergy-harness/migration/import"
import { JsonValue } from "@ericsanchezok/synergy-util/json-value"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { NativeWorkspacePortableTree as Tree } from "../../src/workspace/portable-tree"
import { NativeWorkspacePortableTarget as Native } from "../../src/workspace/portable-target"
import { NativeWorkspaceDownload as Download } from "../../src/workspace/native-download"
import { testRuntime } from "../support/runtime"

test("a private native download retains its original prepared bytes and publishes its Move fact only in the actual owning transaction", async () => {
  await using temporary = await tmpdir()
  const directory = path.join(temporary.path, "source"),
    objects = path.join(temporary.path, "objects"),
    home = path.join(temporary.path, "member")
  await fs.mkdir(directory)
  await fs.mkdir(objects)
  const bytes = new Uint8Array([0, 255, 128, 42])
  await Bun.write(path.join(directory, "current.bin"), bytes)
  await Bun.write(path.join(directory, "untracked.txt"), "current source bytes")
  const store = {
    async put(hash: string, value: Uint8Array) {
      await Bun.write(path.join(objects, hash), value)
    },
    async get(hash: string, maximumBytes: number) {
      const file = Bun.file(path.join(objects, hash))
      if (file.size > maximumBytes) throw new Error("Oversized source object")
      return file.bytes()
    },
  }
  const register = () => WorkspaceBlobs.register("private-download", store)
  await using runtime = await testRuntime({ home, register })
  const saved = await runtime.run(async () => {
    const files = await Tree.capture({ root: directory, directory: path.join(temporary.path, "capture"), store })
    const encoded = new TextEncoder().encode(JSON.stringify(files)),
      manifest = WorkspaceTree.hash(encoded)
    await store.put(manifest, encoded)
    const source = await WorkspaceCatalog.create({
      scopeID: "home",
      backend: { provider: "objects", spec: { blobStore: "private-download" } },
    })
    const importTree = await WorkspaceContent.prepareTreeImport(
      { workspaceID: source.id, scopeID: source.scopeID },
      { path: "selected", manifest },
    )
    const head = await Storage.transaction(() => importTree.publish())
    const snapshot = await WorkspaceArchive.subtree(
      await WorkspaceArchive.saved({
        workspaceID: source.id,
        scopeID: source.scopeID,
        expectedRevision: head.revision,
      }),
      "selected",
    )
    const signal = new AbortController().signal
    const request = await Download.request(
      {
        id: "private-download",
        handoffID: "private-download-handoff",
        source: { workspaceID: source.id, scopeID: source.scopeID, generation: source.binding.generation },
        sourceSnapshotHash: WorkspaceArchive.subtreeHash(snapshot),
        mappingRevision: 1,
        actor: {
          kind: "local",
          subjectID: "fixture",
          displayName: "Fixture",
          clientKind: "cli",
          requestID: "private-download",
        },
      },
      signal,
    )
    const assert = WorkspaceContent.captureOwner(signal)
    const input = {
      source: {
        snapshot,
        store,
        assert,
        async recheck() {
          assert()
          const saved = await WorkspaceArchive.saved({
            workspaceID: source.id,
            scopeID: source.scopeID,
            expectedRevision: head.revision,
          })
          expect(WorkspaceArchive.subtreeHash(await WorkspaceArchive.subtree(saved, "selected"))).toBe(
            request.sourceSnapshotHash,
          )
          assert()
        },
      },
      store,
      signal,
    }
    const receipt = await WorkspaceMove.prepareDownload(request, input)
    expect(receipt).toMatchObject({
      id: request.id,
      outcome: "downloaded-source-version",
      acceptedDiffHash: null,
      sourceSnapshotHash: request.sourceSnapshotHash,
      target: { workspaceID: request.target.workspaceID, generation: 1, manifest: snapshot.manifest },
    })
    expect(await WorkspaceMove.prepareDownload(request, input)).toEqual(receipt)
    const key = ["workspace_move", request.target.scopeID, request.id]
    const raw = await Storage.read<Record<string, unknown>>(key)
    expect(raw.version).toBe(4)
    expect(() => WorkspaceMove.downloadMigration.upgradeRecord!(key, { ...raw, version: 3 })).toThrow()
    const prepared = await Native.prepare({
      handoffID: request.handoffID,
      scopeID: source.scopeID,
      workspaceID: source.id,
      files: snapshot.files,
      store,
      signal,
    })
    expect(await Bun.file(path.join(prepared.directory, "current.bin")).bytes()).toEqual(bytes)
    expect(await Bun.file(path.join(prepared.directory, "untracked.txt")).text()).toBe("current source bytes")
    const wrapper = {
      version: 2 as const,
      workspaceID: prepared.workspaceID,
      scopeID: prepared.scopeID,
      hostID: prepared.hostID,
      path: prepared.directory,
      physicalID: prepared.physicalID,
      receipt: JsonValue.parse(prepared),
      download: { request, receipt },
    }
    await expect(Download.validate(wrapper, signal)).rejects.toThrow("original target controller")
    await Download.run(
      { request, snapshot, signal, assert, sourceStore: store, store, recheck: input.source.recheck },
      async () => {
        await Download.validate(wrapper, signal)
        await expect(
          Download.validate(
            { ...wrapper, download: { request, receipt: { ...receipt, nativeReceiptHash: "0".repeat(64) } } },
            signal,
          ),
        ).rejects.toThrow("actual private preparation")
      },
    )
    const retainedDirectory = prepared.directory + ".retained"
    await fs.rename(prepared.directory, retainedDirectory)
    try {
      await fs.cp(retainedDirectory, prepared.directory, { recursive: true })
      await expect(WorkspaceMove.withDownloadPublication(request, receipt, async () => {}, signal)).rejects.toThrow()
      const unchanged = await WorkspaceMove.inspect(request)
      if (unchanged?.version !== 2) throw new Error("Missing original native download status")
      expect(unchanged.nativePublication).toBeUndefined()
    } finally {
      await fs.rm(prepared.directory, { recursive: true, force: true })
      await fs.rename(retainedDirectory, prepared.directory)
    }
    await expect(WorkspaceCatalog.get(request.target.workspaceID, source.scopeID)).rejects.toThrow()
    let entered = false
    await expect(
      WorkspaceMove.withPublishedDownload(
        request,
        receipt,
        async () => {
          entered = true
        },
        signal,
      ),
    ).rejects.toThrow("publication")
    expect(entered).toBe(false)
    await expect(Storage.transaction(() => WorkspaceMove.publishDownload(request, receipt))).rejects.toThrow("callback")
    const marker = ["private-download-publication", request.id]
    await expect(
      WorkspaceMove.withDownloadPublication(
        request,
        receipt,
        () =>
          Storage.transaction(async () => {
            await WorkspaceMove.publishDownload(request, receipt)
            await Storage.write(marker, { receipt: WorkspaceMove.downloadReceiptHash(receipt) })
            throw new Error("Rollback private native publication")
          }),
        signal,
      ),
    ).rejects.toThrow("Rollback")
    const rolledBack = await WorkspaceMove.inspect(request)
    if (rolledBack?.version !== 2) throw new Error("Missing original native download status")
    expect(rolledBack.nativePublication).toBeUndefined()
    await expect(Storage.read(marker)).rejects.toThrow()
    await WorkspaceMove.withDownloadPublication(
      request,
      receipt,
      () =>
        Storage.transaction(async () => {
          await WorkspaceMove.publishDownload(request, receipt)
          await Storage.write(marker, { receipt: WorkspaceMove.downloadReceiptHash(receipt) })
        }),
      signal,
    )
    expect(await Storage.read(marker)).toEqual({ receipt: WorkspaceMove.downloadReceiptHash(receipt) })
    await WorkspaceMove.release(request, "activated")
    expect(await WorkspaceMove.inspect(request)).toMatchObject({
      state: "activated",
      nativeRequested: false,
      nativePublication: WorkspaceMove.downloadReceiptHash(receipt),
    })
    await Bun.write(path.join(prepared.directory, "current.bin"), "legitimate edit after publication")
    await WorkspaceMove.withPublishedDownload(
      request,
      receipt,
      async () => {
        entered = true
      },
      signal,
    )
    expect(entered).toBe(true)
    expect(await WorkspaceCatalog.get(source.id, source.scopeID)).toEqual(head)
    expect(await Bun.file(path.join(directory, "current.bin")).bytes()).toEqual(bytes)
    return { request, receipt }
  })
  await runtime.close()
  await using cold = await testRuntime({ home, register })
  await cold.run(async () => {
    expect(await WorkspaceMove.inspect(saved.request)).toMatchObject({
      state: "activated",
      nativeRequested: false,
      nativePublication: WorkspaceMove.downloadReceiptHash(saved.receipt),
      downloadReceipt: saved.receipt,
    })
    let entered = false
    await WorkspaceMove.withPublishedDownload(saved.request, saved.receipt, async () => {
      entered = true
    })
    expect(entered).toBe(true)
  })
})

test("the owning download migration upgrades genuine version-three object receipts once without changing their original hashes", async () => {
  await using temporary = await tmpdir()
  const directory = path.join(temporary.path, "source")
  await fs.mkdir(directory)
  await Bun.write(path.join(directory, "retained.txt"), "retained legacy bytes")
  const register = () =>
    WorkspaceBlobs.register("download-migration", {
      put: (hash, bytes) => Storage.writeBinary(["download-migration", hash], bytes),
      get: (hash) => Storage.readBinary(["download-migration", hash]),
    })
  await using runtime = await testRuntime({ register })
  await runtime.run(async () => {
    const source = await WorkspaceBinding.register("home", directory)
    const target = await WorkspaceCatalog.create({
      scopeID: "home",
      backend: { provider: "objects", spec: { blobStore: "download-migration" } },
    })
    const request = WorkspaceMove.Request.parse({
      id: "original-object-move",
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
        kind: "local",
        subjectID: "fixture",
        displayName: "Fixture",
        clientKind: "cli",
        requestID: "original-object-move",
      },
    })
    const receipt = await WorkspaceMove.run(request)
    const key = ["workspace_move", target.scopeID, request.id]
    const original = await Storage.read<Record<string, unknown>>(key)
    const previous = { ...original, version: 3 }
    await Storage.write(key, previous)
    expect((await WorkspaceMove.inspect(request))?.receipt).toEqual(receipt)
    const upgraded = upgradeAccessRecord(key, previous)
    expect(upgraded).toEqual({ ...original, version: 4 })
    expect(upgradeAccessRecord(key, upgraded)).toEqual(upgraded)
    expect(WorkspaceMove.receiptHash((await WorkspaceMove.inspect(request))!.receipt!)).toBe(
      WorkspaceMove.receiptHash(receipt),
    )
    await Storage.write(key, upgraded)
    expect(await Storage.read(key)).toEqual({ ...original, version: 4 })
    expect(await Bun.file(path.join(directory, "retained.txt")).text()).toBe("retained legacy bytes")
  })
})
