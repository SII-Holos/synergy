import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { NativeWorkspacePortableTree } from "../../src/workspace/portable-tree"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
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
  const home = path.join(temporary.path, "member")
  await fs.mkdir(directory)
  await Bun.write(path.join(directory, "value"), "retained source")
  const coordinator = new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") })
  const recover = coordinator.recover.bind(coordinator)
  let loseRelease = false
  let physicalReleases = 0
  const captured = Promise.withResolvers<void>()
  const continueCapture = Promise.withResolvers<void>()
  let holdCapture = true
  using lostAcknowledgement = spyOn(coordinator, "recover").mockImplementation(async (reference) => {
    const original = await recover(reference)
    return {
      ...original,
      async release() {
        const held = (await coordinator.inspect()).some(
          (claim) => claim.id === reference.id && claim.token === reference.token,
        )
        await original.release()
        if (held) physicalReleases++
        if (!loseRelease) return
        loseRelease = false
        throw new Error("Lost original native release acknowledgement")
      },
    }
  })
  await using runtime = await testRuntime({
    home,
    workspaceCoordinator: coordinator,
    register: () =>
      WorkspaceBlobs.register("move-upgrade", {
        async put(hash, bytes) {
          await Storage.writeBinary(["move-upgrade", hash], bytes)
          if (!holdCapture) return
          holdCapture = false
          captured.resolve()
          await continueCapture.promise
        },
        get: (hash) => Storage.readBinary(["move-upgrade", hash]),
      }),
  })
  const cold = await runtime.run(async () => {
    const source = await WorkspaceBinding.register("home", directory)
    const target = await WorkspaceCatalog.create({
      scopeID: "home",
      backend: { provider: "objects", spec: { blobStore: "move-upgrade" } },
    })
    const request = WorkspaceMove.Request.parse({
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
    })
    const legacyID = (input = request, mustExist?: boolean) => {
      const options = Storage.current().store.options
      return (
        "workspace-move:" +
        createHash("sha256")
          .update(
            JSON.stringify([
              input,
              RuntimeContext.current().host.root,
              mustExist === undefined ? options : { ...options, mustExist },
              Storage.current().artifactDirectory,
            ]),
          )
          .digest("hex")
      )
    }
    const original = await WorkspaceAccess.hostClaim({
      id: legacyID(),
      kind: "exclusive",
      roots: [directory],
      durable: true,
    })
    if (!original.recovery) throw new Error("Missing actual legacy native claim")
    const reference = { ...request.source, claim: original.recovery }
    let publishing: Promise<WorkspaceMove.Receipt> | undefined
    try {
      const key = ["workspace_move", target.scopeID, request.id]
      const old = {
        version: 1,
        digest: WorkspaceMove.requestHash(request),
        request,
        state: "preparing",
        nativeRequested: true,
        native: reference,
      }
      await Storage.transaction(async () => {
        await Storage.write(key, old)
        await Storage.write(["workspace_move_active", target.scopeID, target.id, request.id], request)
      })
      expect(upgradeAccessRecord(key, old)).toMatchObject({
        version: 4,
        digest: old.digest,
        request,
        nativeNamespace: { version: 1 },
      })
      expect(await WorkspaceMove.inspect(request)).toMatchObject({ version: 1, digest: old.digest, request })
      publishing = WorkspaceMove.run(request)
      void publishing.catch(() => {})
      await Promise.race([
        captured.promise,
        publishing.then(() => {
          throw new Error("Native capture did not reach its actual body barrier")
        }),
      ])
      expect(await Storage.read(key)).toMatchObject({
        version: 4,
        digest: old.digest,
        native: reference,
        nativeNamespace: { version: 1, selection: await StorageBootstrap.currentIdentity() },
      })
      expect((await Storage.read<{ native: unknown }>(key)).native).toEqual(reference)
      loseRelease = true
      continueCapture.resolve()
      await expect(publishing).rejects.toThrow("Lost original native release")
      expect((await coordinator.inspect()).some((claim) => claim.id === reference.claim.id)).toBe(false)
      expect(await WorkspaceMove.inspect(request)).toMatchObject({ state: "published", nativeRequested: true })
      expect((await Storage.read<{ native: unknown }>(key)).native).toEqual(reference)
      const actualReleases = physicalReleases
      const receipt = await WorkspaceMove.run(request)
      expect(receipt).toMatchObject({ version: 1, requestHash: old.digest })
      expect(physicalReleases).toBe(actualReleases)
      expect(
        await WorkspaceMove.requestForTarget({ id: request.id, workspaceID: target.id, scopeID: target.scopeID }),
      ).toEqual(request)
      await expect(
        WorkspaceMove.requestForTarget({ id: request.id, workspaceID: "another-workspace", scopeID: target.scopeID }),
      ).rejects.toThrow("original target")
      expect(
        await WorkspaceContent.read({ workspaceID: target.id, scopeID: target.scopeID }, "received/value"),
      ).toEqual(Buffer.from("retained source"))
      await WorkspaceMove.release(request, "activated")
      expect(physicalReleases).toBe(actualReleases)
      expect(await WorkspaceMove.inspect(request)).toMatchObject({ state: "activated", nativeRequested: false })
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
      const unknown = WorkspaceMove.Request.parse({
        ...request,
        id: "legacy-unknown-hold",
        actor: { ...request.actor, requestID: "legacy-unknown-hold" },
      })
      const retained = await WorkspaceAccess.hostClaim({
        id: legacyID(unknown),
        kind: "exclusive",
        roots: [directory],
        durable: true,
      })
      try {
        const unknownKey = ["workspace_move", target.scopeID, unknown.id]
        await Storage.write(unknownKey, {
          ...old,
          version: 2,
          digest: WorkspaceMove.requestHash(unknown),
          request: unknown,
          native: undefined,
        })
        await WorkspaceMove.release(unknown, "cancelled")
        expect((await coordinator.inspect()).some((claim) => claim.id === retained.id)).toBe(false)
        expect(await WorkspaceMove.inspect(unknown)).toMatchObject({ state: "cancelled", nativeRequested: false })
      } finally {
        await retained.release()
      }
      const ambiguous = WorkspaceMove.Request.parse({
        ...request,
        id: "legacy-ambiguous-hold",
        actor: { ...request.actor, requestID: "legacy-ambiguous-hold" },
      })
      const unrelated = path.join(temporary.path, "unrelated")
      await fs.mkdir(unrelated)
      const aliases: Awaited<ReturnType<typeof WorkspaceAccess.hostClaim>>[] = []
      try {
        aliases.push(
          await WorkspaceAccess.hostClaim({
            id: legacyID(ambiguous, false),
            kind: "exclusive",
            roots: [directory],
            durable: true,
          }),
        )
        aliases.push(
          await WorkspaceAccess.hostClaim({
            id: legacyID(ambiguous, true),
            kind: "exclusive",
            roots: [unrelated],
            durable: true,
          }),
        )
        await Storage.write(["workspace_move", target.scopeID, ambiguous.id], {
          ...old,
          version: 2,
          digest: WorkspaceMove.requestHash(ambiguous),
          request: ambiguous,
          native: undefined,
        })
        await expect(WorkspaceMove.release(ambiguous, "cancelled")).rejects.toThrow("multiple retained")
        const retainedIDs = new Set((await coordinator.inspect()).map((claim) => claim.id))
        expect(aliases.map((lease) => retainedIDs.has(lease.id))).toEqual([true, true])
        expect(await WorkspaceMove.inspect(ambiguous)).toMatchObject({ state: "cancelled", nativeRequested: true })
      } finally {
        await Promise.all(aliases.map((lease) => lease.release()))
        if (await WorkspaceMove.inspect(ambiguous)) await WorkspaceMove.release(ambiguous, "cancelled")
      }
      const seven = WorkspaceMove.Request.parse({
        ...request,
        id: "legacy-seven-cold",
        actor: { ...request.actor, requestID: "legacy-seven-cold" },
      })
      const held = await WorkspaceAccess.hostClaim({
        id: legacyID(seven, false),
        kind: "exclusive",
        roots: [directory],
        durable: true,
      })
      try {
        if (!held.recovery || !source.binding.physicalID || !source.binding.path)
          throw new Error("Missing actual historical seven-field evidence")
        const reference = {
          ...seven.source,
          hostID: source.binding.hostID,
          physicalID: source.binding.physicalID,
          path: source.binding.path,
          claim: held.recovery,
        }
        const key = ["workspace_move", target.scopeID, seven.id]
        await Storage.write(key, {
          ...old,
          version: 2,
          digest: WorkspaceMove.requestHash(seven),
          request: seven,
          native: reference,
        })
        return { request: seven, key, reference }
      } catch (error) {
        await held.release()
        throw error
      }
    } finally {
      continueCapture.resolve()
      if (publishing) await Promise.allSettled([publishing])
      await original.release()
    }
  })
  try {
    await runtime.close()
    await using reopened = await testRuntime({
      home,
      workspaceCoordinator: coordinator,
      register: () =>
        WorkspaceBlobs.register("move-upgrade", {
          put: (hash, bytes) => Storage.writeBinary(["move-upgrade", hash], bytes),
          get: (hash) => Storage.readBinary(["move-upgrade", hash]),
        }),
    })
    await reopened.run(async () => {
      expect(await Storage.read(cold.key)).toMatchObject({ version: 2, native: cold.reference })
      loseRelease = true
      await expect(WorkspaceMove.release(cold.request, "cancelled")).rejects.toThrow("Lost original native release")
      expect((await Storage.read<{ native: unknown }>(cold.key)).native).toEqual(cold.reference)
      const effects = physicalReleases
      await WorkspaceMove.release(cold.request, "cancelled")
      expect(physicalReleases).toBe(effects)
      expect(await WorkspaceMove.inspect(cold.request)).toMatchObject({
        state: "cancelled",
        nativeRequested: false,
        digest: WorkspaceMove.requestHash(cold.request),
      })
    })
  } finally {
    await (await coordinator.recover(cold.reference.claim)).release()
  }
})

test("fresh datasets and foreign handles cannot adopt or release the original dataset's retained native claim", async () => {
  await using temporary = await tmpdir()
  const directory = path.join(temporary.path, "directory")
  const home = path.join(temporary.path, "member")
  await fs.mkdir(directory)
  await Bun.write(path.join(directory, "value"), "original dataset bytes")
  const coordinator = new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") })
  const recover = coordinator.recover.bind(coordinator)
  let retainOriginal = true
  using unavailableRelease = spyOn(coordinator, "recover").mockImplementation(async (reference) => {
    const original = await recover(reference)
    return {
      ...original,
      async release() {
        if (retainOriginal) {
          retainOriginal = false
          throw new Error("Original physical release dispatch unavailable")
        }
        await original.release()
      },
    }
  })
  const register = () =>
    WorkspaceBlobs.register("dataset-isolation", {
      put: (hash, bytes) => Storage.writeBinary(["dataset-isolation", hash], bytes),
      get: (hash) => Storage.readBinary(["dataset-isolation", hash]),
    })
  const first = await testRuntime({ home, workspaceCoordinator: coordinator, register })
  try {
    const original = await first.run(async () => {
      const source = await WorkspaceBinding.register("home", directory)
      const target = await WorkspaceCatalog.create({
        scopeID: "home",
        backend: { provider: "objects", spec: { blobStore: "dataset-isolation" } },
      })
      const request = WorkspaceMove.Request.parse({
        id: "same-original-dataset",
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
          requestID: "same-original-dataset",
        },
      })
      await expect(WorkspaceMove.run(request)).rejects.toThrow("Original physical release dispatch unavailable")
      const key = ["workspace_move", target.scopeID, request.id]
      const record = await Storage.read(key)
      const claims = (await coordinator.inspect()).filter((claim) => claim.durable && claim.kind === "exclusive")
      expect(claims).toHaveLength(1)
      const retained = { id: claims[0]!.id, token: claims[0]!.token }
      const primary = Storage.current()
      const foreign = await TransactionalStore.open({
        backend: "sqlite",
        filename: path.join(temporary.path, "foreign.sqlite"),
        namespace: "foreign",
      })
      try {
        await Storage.provide({ store: foreign, artifactDirectory: primary.artifactDirectory }, async () => {
          await Storage.write(key, record)
          await expect(WorkspaceMove.release(request, "retired")).rejects.toThrow("actual writable primary Store")
          await expect(StorageBootstrap.currentIdentity()).rejects.toThrow("original primary Store")
        })
      } finally {
        await foreign.close()
      }
      const readonly = await TransactionalStore.open({ ...primary.store.options, readonly: true })
      try {
        await Storage.provide({ ...primary, store: readonly }, async () => {
          await expect(WorkspaceMove.release(request, "retired")).rejects.toThrow()
        })
      } finally {
        await readonly.close()
      }
      expect(await WorkspaceMove.inspect(request)).toMatchObject({ state: "published", nativeRequested: true })
      expect((await coordinator.inspect()).map(({ id, token }) => ({ id, token }))).toContainEqual(retained)
      if (primary.store.options.backend !== "sqlite") throw new Error("Expected the actual SQLite fixture")
      return {
        source,
        target,
        request,
        retained,
        filename: primary.store.options.filename,
        identity: await StorageBootstrap.currentIdentity(),
      }
    })
    await first.close()
    for (const suffix of ["", "-wal", "-shm"])
      await fs.rename(original.filename + suffix, original.filename + suffix + ".retained").catch((error) => {
        if (suffix && error.code === "ENOENT") return
        throw error
      })
    await using replacement = await testRuntime({ home, workspaceCoordinator: coordinator, register })
    await replacement.run(async () => {
      const identity = await StorageBootstrap.currentIdentity()
      expect(identity.target).toBe(original.identity.target)
      expect(identity.storeID).not.toBe(original.identity.storeID)
      expect(identity.artifactStoreID).not.toBe(original.identity.artifactStoreID)
      await Storage.transaction(async (tx) => {
        await WorkspaceCatalog.writeRelocated(original.source, tx)
        await tx.write(StoragePath.workspace(original.target.id), WorkspaceCatalog.Info.parse(original.target))
        await tx.write(StoragePath.workspaceScope(original.target.scopeID, original.target.id), original.target.id)
      })
      expect(await WorkspaceMove.inspect(original.request)).toBeUndefined()
      await expect(WorkspaceMove.run(original.request)).rejects.toThrow("Workspace is busy")
      const key = ["workspace_move", original.target.scopeID, original.request.id]
      expect(await Storage.read(key)).toMatchObject({
        version: 4,
        nativeNamespace: { version: 2, selection: identity },
      })
      await WorkspaceMove.release(original.request, "cancelled")
      expect(await WorkspaceMove.inspect(original.request)).toMatchObject({
        state: "cancelled",
        nativeRequested: false,
      })
      expect((await coordinator.inspect()).map(({ id, token }) => ({ id, token }))).toContainEqual(original.retained)
      expect(await WorkspaceCatalog.get(original.target.id, original.target.scopeID)).toEqual(original.target)
      expect(await Bun.file(path.join(directory, "value")).text()).toBe("original dataset bytes")
    })
  } finally {
    await first.close()
    for (const claim of await coordinator.inspect())
      if (claim.durable && claim.kind === "exclusive") await (await coordinator.recover(claim)).release()
  }
})
