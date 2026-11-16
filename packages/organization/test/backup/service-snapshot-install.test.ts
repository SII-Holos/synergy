import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { SnapshotStore } from "@ericsanchezok/synergy-harness/session/snapshot-store"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { OrganizationBackupCohort as Cohort } from "../../src/backup/cohort"
import { OrganizationRecoveryArchive as Archive } from "../../src/backup/archive"
import { OrganizationServiceNative as Native } from "../../src/backup/service-native"
import { OrganizationStoragePath as Keys } from "../../src/storage/path"
import { openOrganizationRecovery, openOrganizationService } from "../../src/service"
import { fixture } from "../support/organization"

const keys = {
  async current() {
    return { version: "joint-native-install", key: Buffer.alloc(32, 5) }
  },
  async resolve() {
    return Buffer.alloc(32, 5)
  },
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
let directory: string
let saved: Awaited<ReturnType<typeof capture>>

async function capture(name: string) {
  const source = await fixture()
  try {
    await source.initialize()
    const retained = await source.service.maintenance.run(async () => {
      const operation = await SnapshotStore.resolveRepository("home", "service-history")
      await SnapshotStore.initialize(operation)
      const blob = await SnapshotStore.command(
        operation.repository,
        ["hash-object", "-w", "--stdin"],
        undefined,
        "Service checkpoint Snapshot bytes",
      )
      const tree = await SnapshotStore.command(
        operation.repository,
        ["mktree"],
        undefined,
        `100644 blob ${blob}\tevidence.txt\n`,
      )
      await SnapshotStore.retainMany("home", "service-history", [tree])
      return { tree, signerHash: hash(await Storage.read(Keys.signingIdentity())) }
    })
    const encrypted = path.join(directory, name + "-encrypted")
    const report = await Cohort.capture({
      service: Cohort.service(source.service.maintenance),
      async resolve() {
        throw new Error("This service has no Hosted participant")
      },
      directory: encrypted,
      archiveID: name,
      buildVersion: "fixture",
      keys,
      actor: {
        kind: "system",
        subjectID: "host-operator",
        displayName: "Host operator",
        clientKind: "system",
        requestID: name,
      },
    })
    const opened = path.join(directory, name + "-opened")
    await Archive.open({ directory: encrypted, outputDirectory: opened, keys })
    const base = path.join(opened, "namespaces", "0000000000000000")
    const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
    if (!inventory.native || inventory.identity.kind !== "service") throw new Error("Service facet is missing")
    const construction = {
      restoreID: name,
      source: inventory.namespace,
      expected: inventory.native,
      snapshot: inventory.segment.namespace,
      cohort: {
        archiveID: report.archiveID,
        pagesHash: report.pagesHash,
        ordinal: inventory.ordinal,
        source: { orgID: inventory.identity.orgID, deploymentIncarnation: inventory.identity.deploymentIncarnation },
      },
    }
    const request = Native.installationRequest(construction)
    await fs.rm(encrypted, { recursive: true, force: true })
    return {
      ...retained,
      construction,
      request,
      native: {
        directory: path.join(base, "native"),
        source: inventory.namespace,
        expected: inventory.native,
        keys,
        request,
      },
      snapshot: {
        directory: path.join(base, "snapshots"),
        namespaceDirectory: path.join(base, "records"),
        source: inventory.namespace,
        expected: inventory.segment.namespace,
        keys,
        request,
      },
    }
  } finally {
    await source[Symbol.asyncDispose]()
  }
}

beforeAll(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "joint-native-install-")))
  saved = await capture("joint-native-install")
}, 20_000)

afterAll(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

interface Installed {
  permit: HomeRestoration.InstallPermit
  native: Native.Installed
  snapshot: Parameters<typeof SnapshotMaintenance.assertInstalledSegment>[0]
  installationID: string
}
async function installed<T>(body: (value: Installed) => Promise<T>, signal?: AbortSignal) {
  const selected = await HomeRestoration.begin(saved.request, { signal })
  return HomeRestoration.withTarget(selected, (permit) =>
    Native.withInstalled({ ...saved.native, permit, signal }, (native) =>
      SnapshotMaintenance.withInstalledSegment({ ...saved.snapshot, permit, signal }, (snapshot) =>
        body({ permit, native, snapshot, installationID: HomeRestoration.describe(permit).installationID }),
      ),
    ),
  )
}
function restore(value: Installed, signal?: AbortSignal) {
  return StorageCheckpoint.restoreArchive({
    directory: saved.snapshot.namespaceDirectory,
    expected: saved.construction.source,
    restoreID: saved.request.restoreID,
    keys,
    signal,
    async finalize(tx, archive) {
      await Native.adoptRestoration(tx, { ...value, request: saved.request, archive })
    },
  })
}
async function assertEmpty() {
  expect(await RuntimeMaintenance.status()).toBeUndefined()
  expect(await Storage.readMany([Keys.deployment(), Keys.signingIdentity()])).toEqual([undefined, undefined])
  expect(
    await Storage.current().store.operationReceipt(`storage-checkpoint:${saved.request.restoreID}`),
  ).toBeUndefined()
}

test("one original service installation adopts its actual native and Snapshot facets without opening authority", async () => {
  const home = path.join(directory, "target")
  let installationID = ""
  await using target = await openOrganizationRecovery({ home })
  await target.run(async () => {
    await SnapshotMaintenance.withRestoredSegment(saved.snapshot, async (prepared) => {
      expect(prepared.manifest.repositories).toBeGreaterThan(0)
      let verified = 0
      for await (const repository of prepared.repositories()) {
        expect(await SnapshotStore.command(repository.repository, ["show", `${saved.tree}:evidence.txt`])).toBe(
          "Service checkpoint Snapshot bytes",
        )
        verified++
      }
      expect(verified).toBeGreaterThan(0)
    })
    await installed(async (value) => {
      installationID = value.installationID
      await restore(value)
      expect(await SnapshotStore.owner("home", "service-history")).toMatchObject({ retentionID: "service-history" })
      expect(
        await SnapshotStore.command(SnapshotStore.repository("home"), ["show", `${saved.tree}:evidence.txt`]),
      ).toBe("Service checkpoint Snapshot bytes")
      expect(hash(await Storage.read(Keys.signingIdentity()))).toBe(saved.signerHash)
      expect((await RuntimeMaintenance.restoration(installationID))?.target.phase).toBe("recovery-held")
      expect(RuntimeContext.isReady()).toBe(false)
      expect("fetch" in target).toBe(false)
    })
  })
  await target.close()
  await expect(openOrganizationService({ home })).rejects.toThrow("restoration")
  await using cold = await openOrganizationRecovery({ home })
  await cold.run(() =>
    installed(async (value) => {
      expect(value.installationID).toBe(installationID)
      await restore(value)
      expect((await RuntimeMaintenance.status())?.maintenanceID).toBe(installationID)
      expect((await RuntimeMaintenance.status())?.phase).toBe("recovery-held")
      expect(hash(await Storage.read(Keys.signingIdentity()))).toBe(saved.signerHash)
      expect(RuntimeContext.isReady()).toBe(false)
    }),
  )
}, 20_000)

test("the production request requires typed Snapshot and source/cohort identities before native effects", async () => {
  const foreign = await capture("foreign-native-install")
  const missing = structuredClone(saved.request)
  const { snapshot: _, ...payload } = missing.payload
  expect(Native.InstallationRequest.safeParse({ ...missing, payload }).success).toBe(false)
  for (const construction of [
    { ...saved.construction, snapshot: foreign.construction.snapshot },
    { ...saved.construction, snapshot: saved.construction.expected },
    { ...saved.construction, expected: saved.construction.snapshot },
    { ...saved.construction, cohort: { ...saved.construction.cohort, ordinal: 1 } },
    { ...saved.construction, source: foreign.construction.source },
  ])
    expect(() => Native.installationRequest(construction)).toThrow("source namespace or cohort")
  const home = path.join(directory, "wrong-source")
  await using target = await openOrganizationRecovery({ home })
  await target.run(async () => {
    const selected = await HomeRestoration.begin(saved.request)
    await HomeRestoration.withTarget(selected, async (permit) => {
      await expect(
        Native.withInstalled({ ...saved.native, source: foreign.construction.source, permit }, async () => {}),
      ).rejects.toThrow("namespace checkpoint")
      expect(await Bun.file(path.join(home, ".synergy", "home-ownership.json")).exists()).toBe(false)
      await assertEmpty()
    })
  })
  const forged = Native.InstallationRequest.parse({
    ...saved.request,
    payload: { ...saved.request.payload, cohort: { ...saved.request.payload.cohort, ordinal: 1 } },
  })
  const forgedHome = path.join(directory, "forged-cohort")
  await using forgedTarget = await openOrganizationRecovery({ home: forgedHome })
  await forgedTarget.run(async () => {
    const selected = await HomeRestoration.begin(forged)
    await HomeRestoration.withTarget(selected, async (permit) => {
      await expect(Native.withInstalled({ ...saved.native, request: forged, permit }, async () => {})).rejects.toThrow(
        "source namespace or cohort",
      )
      expect(await Bun.file(path.join(forgedHome, ".synergy", "home-ownership.json")).exists()).toBe(false)
    })
  })
}, 20_000)

test("a changed Snapshot facet cannot replay the original intent or publish a different fixed segment", async () => {
  const changed = Native.installationRequest({
    ...saved.construction,
    snapshot: { ...saved.construction.snapshot, createdAt: saved.construction.snapshot.createdAt + 1 },
  })
  const home = path.join(directory, "changed-snapshot")
  await using target = await openOrganizationRecovery({ home })
  await target.run(async () => {
    const selected = await HomeRestoration.begin(saved.request)
    const id = (await HomeRestoration.inspect(selected)).installationID
    await expect(HomeRestoration.begin(changed)).rejects.toThrow("different restoration request")
    expect((await HomeRestoration.inspect(await HomeRestoration.begin(saved.request))).installationID).toBe(id)
    await HomeRestoration.withTarget(selected, (permit) =>
      Native.withInstalled({ ...saved.native, permit }, async () => {
        await expect(
          SnapshotMaintenance.withInstalledSegment(
            {
              ...saved.snapshot,
              expected: { ...saved.snapshot.expected, createdAt: saved.snapshot.expected.createdAt + 1 },
              permit,
            },
            async () => {},
          ),
        ).rejects.toThrow("fixed namespace and Snapshot facet")
        await assertEmpty()
      }),
    )
  })
})

test("ending only the Snapshot callback before actual raw commit rolls back the joint adoption", async () => {
  const home = path.join(directory, "expired-snapshot")
  await using target = await openOrganizationRecovery({ home })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let pending: Promise<unknown> | undefined
  let expired: Installed["snapshot"] | undefined
  const remove = StoreTransaction.prototype.removeTree
  const barrier = spyOn(StoreTransaction.prototype, "removeTree").mockImplementation(async function (
    this: StoreTransaction,
    prefix,
  ) {
    const result = await remove.call(this, prefix)
    if (prefix[0] === "storage_checkpoint_staging") {
      entered.resolve()
      await release.promise
    }
    return result
  })
  try {
    await target.run(async () => {
      const selected = await HomeRestoration.begin(saved.request)
      await HomeRestoration.withTarget(selected, (permit) =>
        Native.withInstalled({ ...saved.native, permit }, async (native) => {
          await SnapshotMaintenance.withInstalledSegment({ ...saved.snapshot, permit }, async (snapshot) => {
            expired = snapshot
            pending = restore({
              permit,
              native,
              snapshot,
              installationID: HomeRestoration.describe(permit).installationID,
            }).then(
              () => undefined,
              (error: unknown) => error,
            )
            await entered.promise
          })
          Native.assertInstalled(native)
          HomeRestoration.assertCurrent(permit)
          expect(() => SnapshotMaintenance.assertInstalledSegment(expired!)).toThrow("closed")
          release.resolve()
          const outcome = await pending
          expect(outcome).toBeInstanceOf(Error)
          expect(String(outcome)).toContain("closed")
          await assertEmpty()
        }),
      )
    })
  } finally {
    release.resolve()
    await pending
    barrier.mockRestore()
  }
}, 20_000)

test("cancellation at the last actual import write rolls back jointly and cold retry retains the original installation", async () => {
  const home = path.join(directory, "cancelled-adoption")
  await using target = await openOrganizationRecovery({ home })
  const controller = new AbortController()
  const reason = new Error("Original joint installation cancelled after actual import cleanup")
  let installationID = ""
  const remove = StoreTransaction.prototype.removeTree
  const barrier = spyOn(StoreTransaction.prototype, "removeTree").mockImplementation(async function (
    this: StoreTransaction,
    prefix,
  ) {
    const result = await remove.call(this, prefix)
    if (prefix[0] === "storage_checkpoint_staging") controller.abort(reason)
    return result
  })
  try {
    await expect(
      target.run(() =>
        installed(async (value) => {
          installationID = value.installationID
          await restore(value, controller.signal)
        }, controller.signal),
      ),
    ).rejects.toBe(reason)
    await target.run(assertEmpty)
  } finally {
    barrier.mockRestore()
  }
  await target.close()
  await using cold = await openOrganizationRecovery({ home })
  await cold.run(() =>
    installed(async (value) => {
      expect(value.installationID).toBe(installationID)
      await restore(value)
      expect((await RuntimeMaintenance.status())?.phase).toBe("recovery-held")
      expect(hash(await Storage.read(Keys.signingIdentity()))).toBe(saved.signerHash)
      expect(RuntimeContext.isReady()).toBe(false)
    }),
  )
}, 20_000)
