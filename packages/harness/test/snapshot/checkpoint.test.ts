import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { SnapshotMaintenance } from "../../src/session/snapshot-maintenance"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { storedSnapshots } from "../../src/session/stored-snapshots"
import { StorageCheckpoint } from "../../src/storage/checkpoint"
import { Identifier } from "../../src/id/id"

test("operator Snapshot capture reads the exported owner after a live pointer change and revokes escaped readers", async () => {
  await using directory = await tmpdir()
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const operation = await SnapshotStore.resolveRepository("home", session.id)
        await SnapshotStore.initialize(operation)
        const blob = await SnapshotStore.command(
          operation.repository,
          ["hash-object", "-w", "--stdin"],
          undefined,
          "captured original",
        )
        const hash = await SnapshotStore.command(
          operation.repository,
          ["mktree"],
          undefined,
          "100644 blob " + blob + "\told.txt\n",
        )
        await SnapshotStore.retainMany("home", session.id, [hash])
        let escaped: AsyncGenerator<string> | undefined
        await SnapshotMaintenance.withCapture(async (capture) => {
          const archive = await capture.exportArchive({
            directory: path.join(directory.path, "namespace"),
            archiveID: "snapshot-capture",
            namespaceID: "runtime",
            buildVersion: "fixture",
            keys: {
              async current() {
                return { version: "fixture-key", key: Buffer.alloc(32, 7) }
              },
              async resolve() {
                return Buffer.alloc(32, 7)
              },
            },
            protect: () => true,
          })
          await Storage.transaction(() =>
            SnapshotStore.write(StoragePath.snapshotOwner("home", session.id), {
              version: 3,
              backend: "shared",
              retentionID: "changed-owner",
            }),
          )
          expect(await Array.fromAsync(SnapshotStore.roots("home", session.id))).toEqual([])
          const owners = await Array.fromAsync(capture.owners(archive))
          expect(owners).toHaveLength(1)
          expect(await Array.fromAsync(capture.roots(owners[0]))).toEqual([hash])
          await expect(capture.roots({ ...owners[0] }).next()).rejects.toThrow("captured owner")
          await Storage.provide(
            { ...Storage.current(), artifactDirectory: path.join(directory.path, "foreign-data") },
            async () => {
              await expect(capture.roots(owners[0]).next()).rejects.toThrow("capture")
            },
          )
          const partial = capture.roots(owners[0])
          await partial.next()
          await expect(partial.return(undefined)).rejects.toThrow("incomplete")
          escaped = capture.roots(owners[0])
        })
        if (!escaped) throw new Error("No escaped capture reader")
        await expect(escaped.next()).rejects.toThrow("capture")
      },
    }),
  )
}, 15000)

test("Snapshot capture never issues a sealed namespace handle for an unowned historical root", async () => {
  await using directory = await tmpdir()
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        await SnapshotStore.initialize(await SnapshotStore.resolveRepository("home", session.id))
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          isRoot: true,
          rootID: messageID,
          time: { created: 1 },
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID,
          sessionID: session.id,
          type: "snapshot",
          snapshot: "a".repeat(40),
        })
        await Session.flushPartWrites(session.id)
        await expect(
          SnapshotMaintenance.withCapture((capture) =>
            capture.exportArchive({
              directory: path.join(directory.path, "namespace"),
              archiveID: "missing-root",
              namespaceID: "runtime",
              buildVersion: "fixture",
              keys: {
                async current() {
                  return { version: "fixture-key", key: Buffer.alloc(32, 7) }
                },
                async resolve() {
                  return Buffer.alloc(32, 7)
                },
              },
              protect: () => true,
            }),
          ),
        ).rejects.toThrow("missing or unowned")
      },
    }),
  )
}, 15000)

test("operator capture follows the captured native repository format despite a differently selected Runtime backend", async () => {
  await using directory = await tmpdir()
  await using runtime = await testRuntime({
    register() {
      SnapshotStore.registerStorage(storedSnapshots())
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const operation = await SnapshotStore.resolveRepository("home", session.id)
        await SnapshotStore.initialize(operation)
        const blob = await SnapshotStore.command(
          operation.repository,
          ["hash-object", "-w", "--stdin"],
          undefined,
          "native format",
        )
        const hash = await SnapshotStore.command(
          operation.repository,
          ["mktree"],
          undefined,
          "100644 blob " + blob + "\told.txt\n",
        )
        await SnapshotStore.command(operation.repository, [
          "update-ref",
          SnapshotStore.reference(session.id, hash),
          hash,
        ])
        await Storage.write(StoragePath.snapshotRepository("home"), { version: 2, objectFormat: "sha1" })
        await expect(Array.fromAsync(SnapshotStore.roots("home", session.id))).rejects.toThrow("storage mode differs")
        await SnapshotMaintenance.withCapture(async (capture) => {
          const archive = await capture.exportArchive({
            directory: path.join(directory.path, "namespace"),
            archiveID: "native-format",
            namespaceID: "runtime",
            buildVersion: "fixture",
            keys: {
              async current() {
                return { version: "fixture-key", key: Buffer.alloc(32, 7) }
              },
              async resolve() {
                return Buffer.alloc(32, 7)
              },
            },
            protect: () => true,
          })
          const [owner] = await Array.fromAsync(capture.owners(archive))
          expect(capture.describe(owner).layout).toBe("native")
          expect(capture.describe(owner).namespace).toEqual(archive.namespace)
          expect(await Array.fromAsync(capture.roots(owner))).toEqual([hash])
        })
      },
    }),
  )
}, 15000)

test("captured legacy ownership retains its historical readable tree inventory", async () => {
  await using directory = await tmpdir()
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const repository = SnapshotStore.legacyRepository("home", session.id)
        await SnapshotStore.initializeBareRepository(repository)
        const blob = await SnapshotStore.command(
          repository,
          ["hash-object", "-w", "--stdin"],
          undefined,
          "legacy history",
        )
        const hash = await SnapshotStore.command(
          repository,
          ["mktree"],
          undefined,
          "100644 blob " + blob + "\told.txt\n",
        )
        await Storage.write(StoragePath.snapshotOwner("home", session.id), { version: 2, backend: "legacy" })
        await SnapshotMaintenance.withCapture(async (capture) => {
          const archive = await capture.exportArchive({
            directory: path.join(directory.path, "namespace"),
            archiveID: "legacy-root",
            namespaceID: "runtime",
            buildVersion: "fixture",
            keys: {
              async current() {
                return { version: "fixture-key", key: Buffer.alloc(32, 7) }
              },
              async resolve() {
                return Buffer.alloc(32, 7)
              },
            },
            protect: () => true,
          })
          const [owner] = await Array.fromAsync(capture.owners(archive))
          expect(capture.describe(owner)).toMatchObject({
            layout: "legacy",
            owner: { version: 3, backend: "legacy", retentionID: session.id },
          })
          expect(await Array.fromAsync(capture.roots(owner))).toEqual([hash])
        })
      },
    }),
  )
}, 15000)

test("captured stored Snapshot roots come from the encrypted archive after live manifests disappear", async () => {
  await using directory = await tmpdir()
  await using runtime = await testRuntime({
    register() {
      SnapshotStore.registerStorage(storedSnapshots())
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const operation = await SnapshotStore.resolveRepository("home", session.id)
        await SnapshotStore.initialize(operation)
        const blob = await SnapshotStore.command(
          operation.repository,
          ["hash-object", "-w", "--stdin"],
          undefined,
          "stored original",
        )
        const hash = await SnapshotStore.command(
          operation.repository,
          ["mktree"],
          undefined,
          "100644 blob " + blob + "\told.txt\n",
        )
        await SnapshotStore.retainMany("home", session.id, [hash])
        await SnapshotMaintenance.withCapture(async (capture) => {
          const archive = await capture.exportArchive({
            directory: path.join(directory.path, "namespace"),
            archiveID: "stored-capture",
            namespaceID: "runtime",
            buildVersion: "fixture",
            keys: {
              async current() {
                return { version: "fixture-key", key: Buffer.alloc(32, 7) }
              },
              async resolve() {
                return Buffer.alloc(32, 7)
              },
            },
            protect: () => true,
          })
          await Storage.removeTree(["snapshot-v2", "home", "content", session.id])
          expect(await Array.fromAsync(SnapshotStore.roots("home", session.id))).toEqual([])
          const [owner] = await Array.fromAsync(capture.owners(archive))
          expect(capture.describe(owner)).toMatchObject({ sessionID: session.id, owner: { retentionID: session.id } })
          expect(await Array.fromAsync(capture.roots(owner))).toEqual([hash])
        })
      },
    }),
  )
}, 15000)

test("Runtime shutdown aborts and drains an active Snapshot archive before releasing storage", async () => {
  await using directory = await tmpdir()
  const runtime = await testRuntime()
  const entered = Promise.withResolvers<void>()
  const original = StorageCheckpoint.entries
  using blocked = spyOn(StorageCheckpoint, "entries").mockImplementation(async function* (input) {
    entered.resolve()
    await new Promise<void>((_resolve, reject) => {
      if (input.signal?.aborted) return reject(input.signal.reason)
      input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true })
    })
    yield* original(input)
  })
  const capture = runtime
    .run(() =>
      SnapshotMaintenance.withCapture((port) =>
        port.exportArchive({
          directory: path.join(directory.path, "namespace"),
          archiveID: "closing-capture",
          namespaceID: "runtime",
          buildVersion: "fixture",
          keys: {
            async current() {
              return { version: "fixture-key", key: Buffer.alloc(32, 7) }
            },
            async resolve() {
              return Buffer.alloc(32, 7)
            },
          },
          protect: () => true,
        }),
      ),
    )
    .then(
      () => ({ completed: true as const }),
      (error: unknown) => ({ error }),
    )
  try {
    await entered.promise
    await runtime.close()
    const outcome = await capture
    expect(outcome).toHaveProperty("error")
    if (!("error" in outcome)) throw new Error("Snapshot capture completed after Runtime shutdown")
    expect(String(outcome.error)).toContain("closing")
  } finally {
    await runtime.close()
  }
}, 15000)
