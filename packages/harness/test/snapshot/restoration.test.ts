import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { RuntimeContext } from "../../src/lifecycle/context"
import { HomeRestoration } from "../../src/lifecycle/home-restoration"
import { SnapshotRestoration } from "../../src/session/snapshot-restoration"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotMaintenance } from "../../src/session/snapshot-maintenance"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { storedSnapshots } from "../../src/session/stored-snapshots"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StorageCheckpoint } from "../../src/storage/checkpoint"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { ServerProcessLock } from "../../src/util/server-process-lock"
import { storageTestRuntime } from "../support/storage-runtime"

const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(StorageCheckpoint.Manifest.parse(value)))
    .digest("hex")
const originalRequest = (
  saved: { namespace: StorageCheckpoint.Manifest; segment: { namespace: StorageCheckpoint.Manifest } },
  restoreID = "snapshot-install",
) =>
  HomeRestoration.Request.parse({
    restoreID,
    owner: "organization",
    sourceHash: digest(saved.namespace),
    payload: { snapshot: { manifestHash: digest(saved.segment.namespace) } },
  })

async function fixture(home?: string, external = false) {
  const selected = await fs.realpath(
    home ?? (await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "snapshot-install-"))),
  )
  const runtime = await storageTestRuntime({ home: selected })
  runtime.run(() => HomeRestoration.register())
  if (external) runtime.run(() => SnapshotStore.registerStorage(storedSnapshots()))
  const root = path.join(selected, ".synergy")
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(root, "data", "restore.sqlite"),
    namespace: "restore",
  })
  const lock = await runtime.run(async () => {
    RuntimeContext.current().storage = { store, artifactDirectory: path.join(root, "data", "artifacts") }
    return ServerProcessLock.acquire()
  })
  return {
    home: selected,
    root,
    store,
    run: runtime.run,
    async close() {
      await store.close()
      await runtime.run(() => lock.release())
      await runtime.close()
    },
  }
}
async function captured(source: Awaited<ReturnType<typeof fixture>>) {
  const key = randomBytes(32)
  const keys = {
    async current() {
      return { version: "fixture", key }
    },
    async resolve() {
      return key
    },
  }
  const saved = await source.run(async () => {
    const operation = await SnapshotStore.resolveRepository("scope", "session")
    await SnapshotStore.initialize(operation)
    const blob = await SnapshotStore.command(
      operation.repository,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "Installed native history",
    )
    const root = await SnapshotStore.command(
      operation.repository,
      ["mktree"],
      undefined,
      `100644 blob ${blob}\tfile.txt\n`,
    )
    await SnapshotStore.retainMany("scope", "session", [root])
    const orphan = await SnapshotStore.command(
      operation.repository,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "Unclassified installation bytes",
    )
    await SnapshotGit.checked(operation.repository, ["update-ref", "refs/custom/history", root])
    const legacy = SnapshotStore.legacyRepository("scope", "legacy")
    await SnapshotStore.initializeBareRepository(legacy, "durable", { emptyTemplate: true })
    const legacyBlob = await SnapshotStore.command(
      legacy,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "Legacy installed history",
    )
    const legacyRoot = await SnapshotStore.command(
      legacy,
      ["mktree"],
      undefined,
      `100644 blob ${legacyBlob}\tlegacy.txt\n`,
    )
    await SnapshotGit.checked(legacy, ["update-ref", "refs/custom/legacy", legacyRoot])
    await Storage.write(StoragePath.snapshotOwner("scope", "legacy"), {
      version: 3,
      backend: "legacy",
      retentionID: "legacy",
    })
    const preserved = SnapshotStore.archivedRepository({ scopeID: "scope", layout: "legacy", name: ".shared.old" })
    await SnapshotStore.initializeBareRepository(preserved, "durable", { emptyTemplate: true })
    const preservedBlob = await SnapshotStore.command(
      preserved,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "Preserved prior shared repository",
    )
    return SnapshotMaintenance.withCapture(async (capture) => {
      const namespace = await capture.exportArchive({
        directory: path.join(source.home, "namespace"),
        archiveID: "snapshot-source",
        namespaceID: "runtime",
        buildVersion: "fixture",
        keys,
        protect: () => true,
      })
      const segment = await capture.exportSnapshots({
        archive: namespace,
        directory: path.join(source.home, "segment"),
      })
      return { namespace: namespace.namespace, segment, root, orphan, legacyRoot, preservedBlob }
    })
  })
  return { ...saved, keys, key }
}

test("Snapshot native installation retains exact canonical history across cold retry and rejects copied publication references", async () => {
  const source = await fixture()
  const target = await fixture()
  const saved = await captured(source)
  await fs.rm(path.join(source.root, "data", "artifacts"), { recursive: true, force: true })
  const digest = (value: unknown) =>
    createHash("sha256")
      .update(JSON.stringify(StorageCheckpoint.Manifest.parse(value)))
      .digest("hex")
  const request = HomeRestoration.Request.parse({
    restoreID: "snapshot-install",
    owner: "organization",
    sourceHash: digest(saved.namespace),
    payload: { snapshot: { manifestHash: digest(saved.segment.namespace) } },
  })
  let expired: SnapshotRestoration.Installed | undefined
  let closed = false
  try {
    await target.run(async () => {
      const installation = await HomeRestoration.begin(request)
      await HomeRestoration.withTarget(installation, async (permit) => {
        await HomeRestoration.installOwner(permit, {
          identity: "a".repeat(64),
          readerContract: "native-recovery-fixture-v1",
        })
        await SnapshotRestoration.withInstalled(
          {
            directory: saved.segment.directory,
            namespaceDirectory: path.join(source.home, "namespace"),
            source: saved.namespace,
            expected: saved.segment.namespace,
            keys: saved.keys,
            permit,
            request,
          },
          async (installed) => {
            expired = installed
            SnapshotRestoration.assertInstalled(installed)
            expect(() => SnapshotRestoration.assertInstalled({ ...installed })).toThrow("native")
            expect(
              await SnapshotGit.checked(SnapshotStore.repository("scope"), ["show", `${saved.root}:file.txt`]),
            ).toBe("Installed native history")
            expect(
              await SnapshotGit.checked(SnapshotStore.repository("scope"), ["cat-file", "blob", saved.orphan]),
            ).toBe("Unclassified installation bytes")
            expect(
              await SnapshotGit.checked(SnapshotStore.legacyRepository("scope", "legacy"), [
                "show",
                `${saved.legacyRoot}:legacy.txt`,
              ]),
            ).toBe("Legacy installed history")
            expect(
              await SnapshotGit.checked(
                SnapshotStore.archivedRepository({ scopeID: "scope", layout: "legacy", name: ".shared.old" }),
                ["cat-file", "blob", saved.preservedBlob],
              ),
            ).toBe("Preserved prior shared repository")
            await StorageCheckpoint.restoreArchive({
              directory: path.join(source.home, "namespace"),
              keys: saved.keys,
              restoreID: request.restoreID,
              async finalize() {
                SnapshotRestoration.assertInstalled(installed)
              },
            })
            expect(await SnapshotStore.owner("scope", "session")).toEqual({
              version: 3,
              backend: "shared",
              retentionID: "session",
            })
            expect((await SnapshotStore.ownsMany("scope", "session", [saved.root])).has(saved.root)).toBe(true)
          },
        )
        expect(() => SnapshotRestoration.assertInstalled(expired!)).toThrow("closed")
      })
    })
    await target.close()
    closed = true
    const reopened = await fixture(target.home)
    try {
      await reopened.run(async () => {
        const installation = await HomeRestoration.begin(request)
        await HomeRestoration.withTarget(installation, async (permit) => {
          await SnapshotRestoration.withInstalled(
            {
              directory: saved.segment.directory,
              namespaceDirectory: path.join(source.home, "namespace"),
              source: saved.namespace,
              expected: saved.segment.namespace,
              keys: saved.keys,
              permit,
              request,
            },
            async (installed) => {
              await installed.verify()
              expect(
                await SnapshotGit.checked(SnapshotStore.repository("scope"), ["rev-parse", "refs/custom/history"]),
              ).toBe(saved.root)
            },
          )
          const reference = SnapshotRestoration.reference(SnapshotStore.repository("scope"))
          const value = await Bun.file(reference).json()
          await Bun.write(reference, JSON.stringify({ ...value, installationID: crypto.randomUUID() }))
          await expect(
            SnapshotRestoration.withInstalled(
              {
                directory: saved.segment.directory,
                namespaceDirectory: path.join(source.home, "namespace"),
                source: saved.namespace,
                expected: saved.segment.namespace,
                keys: saved.keys,
                permit,
                request,
              },
              async () => {},
            ),
          ).rejects.toThrow("reference")
        })
      })
    } finally {
      await reopened.close()
    }
  } finally {
    saved.key.fill(0)
    await source.close()
    if (!closed) await target.close()
    await fs.rm(source.home, { recursive: true, force: true })
    await fs.rm(target.home, { recursive: true, force: true })
  }
}, 15_000)

test("identical native repositories cannot be adopted without this actual installation's publication reference", async () => {
  const source = await fixture()
  const first = await fixture()
  const foreign = await fixture()
  const saved = await captured(source)
  const request = originalRequest(saved)
  try {
    await first.run(async () => {
      const target = await HomeRestoration.begin(request)
      await HomeRestoration.withTarget(target, async (permit) => {
        await HomeRestoration.installOwner(permit, {
          identity: "a".repeat(64),
          readerContract: "native-recovery-fixture-v1",
        })
        await SnapshotRestoration.withInstalled(
          {
            directory: saved.segment.directory,
            namespaceDirectory: path.join(source.home, "namespace"),
            source: saved.namespace,
            expected: saved.segment.namespace,
            keys: saved.keys,
            permit,
            request,
          },
          async () => {},
        )
      })
    })
    const canonical = await first.run(async () => SnapshotStore.repository("scope"))
    await foreign.run(async () => {
      const target = await HomeRestoration.begin(request)
      await HomeRestoration.withTarget(target, async (permit) => {
        await HomeRestoration.installOwner(permit, {
          identity: "a".repeat(64),
          readerContract: "native-recovery-fixture-v1",
        })
        const destination = SnapshotStore.repository("scope")
        await fs.cp(canonical, destination, { recursive: true })
        const input = {
          directory: saved.segment.directory,
          namespaceDirectory: path.join(source.home, "namespace"),
          source: saved.namespace,
          expected: saved.segment.namespace,
          keys: saved.keys,
          permit,
          request,
        }
        await expect(SnapshotRestoration.withInstalled(input, async () => {})).rejects.toThrow("another installation")
        await fs.rm(SnapshotRestoration.reference(destination))
        await expect(SnapshotRestoration.withInstalled(input, async () => {})).rejects.toThrow("reference")
        expect(await SnapshotGit.checked(destination, ["show", `${saved.root}:file.txt`])).toBe(
          "Installed native history",
        )
      })
    })
  } finally {
    saved.key.fill(0)
    await Promise.all([source.close(), first.close(), foreign.close()])
    await Promise.all(
      [source.home, first.home, foreign.home].map((home) => fs.rm(home, { recursive: true, force: true })),
    )
  }
}, 15_000)

test("stored Snapshot installation merges fixed retention graphs and the imported owner reads from the new Home", async () => {
  const source = await fixture(undefined, true)
  const target = await fixture(undefined, true)
  const key = randomBytes(32)
  const keys = {
    async current() {
      return { version: "fixture", key }
    },
    async resolve() {
      return key
    },
  }
  try {
    const saved = await source.run(async () => {
      const roots: string[] = []
      for (const id of ["first", "second"]) {
        const operation = await SnapshotStore.resolveRepository("scope", id)
        await SnapshotStore.initialize(operation)
        const blob = await SnapshotStore.command(
          operation.repository,
          ["hash-object", "-w", "--stdin"],
          undefined,
          `Stored ${id} history`,
        )
        const root = await SnapshotStore.command(
          operation.repository,
          ["mktree"],
          undefined,
          `100644 blob ${blob}\tfile.txt\n`,
        )
        await SnapshotStore.retainMany("scope", id, [root])
        roots.push(root)
      }
      return SnapshotMaintenance.withCapture(async (capture) => {
        const namespace = await capture.exportArchive({
          directory: path.join(source.home, "namespace"),
          archiveID: "stored-source",
          namespaceID: "runtime",
          buildVersion: "fixture",
          keys,
          protect: () => true,
        })
        const segment = await capture.exportSnapshots({
          archive: namespace,
          directory: path.join(source.home, "segment"),
        })
        return { namespace: namespace.namespace, segment, roots }
      })
    })
    const request = originalRequest(saved, "stored-install")
    await target.run(async () => {
      const installation = await HomeRestoration.begin(request)
      await HomeRestoration.withTarget(installation, async (permit) => {
        await HomeRestoration.installOwner(permit, {
          identity: "a".repeat(64),
          readerContract: "native-recovery-fixture-v1",
        })
        await SnapshotRestoration.withInstalled(
          {
            directory: saved.segment.directory,
            namespaceDirectory: path.join(source.home, "namespace"),
            expected: saved.segment.namespace,
            source: saved.namespace,
            keys,
            request,
            permit,
          },
          async (installed) => {
            await StorageCheckpoint.restoreArchive({
              directory: path.join(source.home, "namespace"),
              restoreID: request.restoreID,
              keys,
              async finalize() {
                SnapshotRestoration.assertInstalled(installed)
              },
            })
            for (const [index, id] of ["first", "second"].entries()) {
              expect((await SnapshotStore.ownsMany("scope", id, [saved.roots[index]])).has(saved.roots[index])).toBe(
                true,
              )
              expect(
                await SnapshotGit.checked(SnapshotStore.repository("scope"), [
                  "show",
                  `${saved.roots[index]}:file.txt`,
                ]),
              ).toBe(`Stored ${id} history`)
            }
          },
        )
      })
    })
  } finally {
    key.fill(0)
    await Promise.all([source.close(), target.close()])
    await Promise.all([source.home, target.home].map((home) => fs.rm(home, { recursive: true, force: true })))
  }
}, 15_000)

test("a fully authenticated segment cannot omit a complete canonical Snapshot partition", async () => {
  const source = await fixture()
  const target = await fixture()
  const saved = await captured(source)
  const subset = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(source.home, "subset.sqlite"),
    namespace: "subset",
  })
  try {
    const expected = await source.run(() =>
      Storage.provide({ store: subset, artifactDirectory: path.join(source.home, "subset-content") }, async () => {
        await Storage.write(["snapshot-segment", "manifest"], {
          format: "synergy-snapshot-segment",
          version: 1,
          namespaceID: saved.namespace.namespaceID,
          namespaceRecords: saved.namespace.records,
          repositories: 0,
          roots: 0,
          refs: 0,
          packs: 0,
        })
        return StorageCheckpoint.exportArchive({
          directory: path.join(source.home, "subset"),
          archiveID: "subset",
          namespaceID: saved.namespace.namespaceID,
          buildVersion: "fixture",
          keys: saved.keys,
          protect: () => true,
        })
      }),
    )
    const request = originalRequest(
      { namespace: saved.namespace, segment: { namespace: expected } },
      "missing-partition",
    )
    await target.run(async () => {
      const installation = await HomeRestoration.begin(request)
      await HomeRestoration.withTarget(installation, async (permit) => {
        await HomeRestoration.installOwner(permit, {
          identity: "a".repeat(64),
          readerContract: "native-recovery-fixture-v1",
        })
        let ordinaryPreparation = false
        await SnapshotMaintenance.withRestoredSegment(
          { directory: path.join(source.home, "subset"), expected, source: saved.namespace, keys: saved.keys },
          async () => {
            ordinaryPreparation = true
          },
        )
        expect(ordinaryPreparation).toBe(true)
        await expect(
          SnapshotRestoration.withInstalled(
            {
              directory: path.join(source.home, "subset"),
              namespaceDirectory: path.join(source.home, "namespace"),
              source: saved.namespace,
              expected,
              keys: saved.keys,
              permit,
              request,
            },
            async () => {},
          ),
        ).rejects.toThrow("canonical Snapshot owner")
        expect(await Bun.file(path.join(SnapshotStore.repository("scope"), "HEAD")).exists()).toBe(false)
      })
    })
  } finally {
    saved.key.fill(0)
    await subset.close()
    await Promise.all([source.close(), target.close()])
    await Promise.all([source.home, target.home].map((home) => fs.rm(home, { recursive: true, force: true })))
  }
}, 15_000)

test("cancelled or changed native publications do not produce usable installation evidence", async () => {
  const source = await fixture()
  const target = await fixture()
  const saved = await captured(source)
  const request = originalRequest(saved)
  const reason = new Error("cancel Snapshot installation")
  try {
    await target.run(async () => {
      const installation = await HomeRestoration.begin(request)
      await HomeRestoration.withTarget(installation, async (permit) => {
        await HomeRestoration.installOwner(permit, {
          identity: "a".repeat(64),
          readerContract: "native-recovery-fixture-v1",
        })
        const input = {
          directory: saved.segment.directory,
          namespaceDirectory: path.join(source.home, "namespace"),
          source: saved.namespace,
          expected: saved.segment.namespace,
          keys: saved.keys,
          permit,
          request,
        }
        const controller = new AbortController()
        let expired: SnapshotRestoration.Installed | undefined
        await expect(
          SnapshotRestoration.withInstalled({ ...input, signal: controller.signal }, async (installed) => {
            expired = installed
            controller.abort(reason)
            SnapshotRestoration.assertInstalled(installed)
          }),
        ).rejects.toBe(reason)
        expect(() => SnapshotRestoration.assertInstalled(expired!)).toThrow()
        await expect(
          SnapshotRestoration.withInstalled(input, async () => {
            await SnapshotStore.command(
              SnapshotStore.repository("scope"),
              ["hash-object", "-w", "--stdin"],
              undefined,
              "Unexpected extra native history",
            )
          }),
        ).rejects.toThrow("fixed closure")
        await expect(SnapshotRestoration.withInstalled(input, async () => {})).rejects.toThrow("fixed closure")
      })
    })
  } finally {
    saved.key.fill(0)
    await Promise.all([source.close(), target.close()])
    await Promise.all([source.home, target.home].map((home) => fs.rm(home, { recursive: true, force: true })))
  }
}, 15_000)
