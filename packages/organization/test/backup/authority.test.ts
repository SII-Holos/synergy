import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { OrganizationBackupCohort as Cohort } from "../../src/backup/cohort"
import { OrganizationRecoveryArchive as Archive } from "../../src/backup/archive"
import { OrganizationServiceNative as Native } from "../../src/backup/service-native"
import { OrganizationRecoveryAuthority as Authority } from "../../src/backup/authority"
import { OrganizationCurrentAuthority as Current } from "../../src/backup/current-authority"
import { OrganizationRecovery as Recovery } from "../../src/backup/recovery"
import { OrganizationRecord as Record } from "../../src/storage/records"
import { OrganizationStoragePath as Keys } from "../../src/storage/path"
import { openOrganizationRecovery } from "../../src/service"
import { fixture as organizationFixture, password } from "../support/organization"

const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item)))
    .digest("hex")
const sourceKeys = {
  async current() {
    return { version: "source", key: Buffer.alloc(32, 7) }
  },
  async resolve(version: string) {
    if (version !== "source") throw new Error("Unknown fixture key")
    return Buffer.alloc(32, 7)
  },
}
const keys = {
  async current() {
    return { version: "material", key: Buffer.alloc(32, 8) }
  },
  async resolve(version: string) {
    if (version === "source") return sourceKeys.resolve(version)
    if (version !== "material") throw new Error("Unknown fixture key")
    return Buffer.alloc(32, 8)
  },
}
const clients = [
  { clientID: "desktop", kind: "desktop" as const, redirectUri: "synergy://organization-auth/callback" as const },
]
let directory: string
let source: Awaited<ReturnType<typeof organizationFixture>>
let input: Omit<Parameters<typeof Native.withInstalled>[0], "permit">
let snapshot: StorageCheckpoint.Manifest
let h0: Awaited<ReturnType<typeof AuthorityJournal.head>>
let h1: typeof h0

beforeAll(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "recovery-authority-")))
  source = await organizationFixture(undefined, { clientAuthentication: { clients } })
  const owner = await source.initialize()
  const encrypted = path.join(directory, "encrypted")
  const report = await Cohort.capture({
    service: Cohort.service(source.service.maintenance),
    async resolve() {
      throw new Error("No Hosted participant exists in this fixture")
    },
    directory: encrypted,
    archiveID: "recovery-authority",
    buildVersion: "fixture",
    keys: sourceKeys,
    actor: {
      kind: "system",
      subjectID: "host-operator",
      displayName: "Host operator",
      clientKind: "system",
      requestID: "recovery-authority",
    },
  })
  h0 = await source.service.maintenance.run(() => AuthorityJournal.head())
  const changed = await owner.request("POST", "/auth/password", {
    currentPassword: password,
    password: "new source password after checkpoint",
  })
  expect(changed.status).toBe(200)
  h1 = await source.service.maintenance.run(() => AuthorityJournal.head())
  const opened = path.join(directory, "opened")
  await Archive.open({ directory: encrypted, outputDirectory: opened, keys: sourceKeys })
  const base = path.join(opened, "namespaces", "0000000000000000")
  const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
  if (!inventory.native) throw new Error("Service native facet is missing")
  snapshot = inventory.segment.namespace
  input = {
    directory: path.join(base, "native"),
    expected: inventory.native,
    source: inventory.namespace,
    keys,
    request: Native.installationRequest({
      restoreID: "recovery-authority",
      source: inventory.namespace,
      expected: inventory.native,
      snapshot: inventory.segment.namespace,
      cohort: {
        archiveID: report.archiveID,
        pagesHash: report.pagesHash,
        ordinal: inventory.ordinal,
        source: { orgID: inventory.identity.orgID, deploymentIncarnation: inventory.identity.deploymentIncarnation },
      },
    }),
  }
}, 20_000)

afterAll(async () => {
  await source?.[Symbol.asyncDispose]()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

type InstalledContext = {
  permit: HomeRestoration.InstallPermit
  native: Native.Installed
  installationID: string
  home: string
}
async function target<T>(name: string, body: (context: InstalledContext) => Promise<T>, restore = true) {
  const home = path.join(directory, name)
  await using runtime = await openOrganizationRecovery({ home })
  return runtime.run(async () => {
    const selected = await HomeRestoration.begin(input.request)
    return HomeRestoration.withTarget(selected, (permit) =>
      Native.withInstalled({ ...input, permit }, (native) =>
        SnapshotMaintenance.withInstalledSegment(
          {
            directory: path.join(path.dirname(input.directory), "snapshots"),
            namespaceDirectory: path.join(path.dirname(input.directory), "records"),
            source: input.source,
            expected: snapshot,
            keys,
            permit,
            request: input.request,
          },
          async (installed) => {
            if (restore)
              await StorageCheckpoint.restoreArchive({
                directory: path.join(path.dirname(input.directory), "records"),
                expected: input.source,
                keys,
                restoreID: input.request.restoreID,
                finalize: (tx, archive) =>
                  Native.adoptRestoration(tx, {
                    permit,
                    request: input.request,
                    native,
                    snapshot: installed,
                    archive,
                  }).then(() => {}),
              })
            return body({ permit, native, installationID: HomeRestoration.describe(permit).installationID, home })
          },
        ),
      ),
    )
  })
}
function prepare(context: InstalledContext, provider = keys) {
  return Authority.prepare({
    permit: context.permit,
    request: input.request,
    native: context.native,
    namespaceDirectory: path.join(path.dirname(input.directory), "records"),
    keys: provider,
  })
}
async function currentAuthority() {
  return Storage.snapshot(async (tx) => ({
    deployment: await Storage.read(Keys.deployment()),
    signing: Record.SigningIdentity.parse(await Storage.read(Keys.signingIdentity())),
    authHash: hash(await tx.query({ prefix: ["organization", "logins"], limit: 100 })),
    accountsHash: hash(await tx.query({ prefix: Keys.accounts(), limit: 100 })),
    head: await AuthorityJournal.head(),
  }))
}

test("preparing a fresh non-active signer preserves H0 while the actual source has a later H1", async () => {
  expect(h1.journalID).toBe(h0.journalID)
  expect(h1.sequence).toBeGreaterThan(h0.sequence)
  expect(h1.tailHash).not.toBe(h0.tailHash)
  let expired: Authority.Prepared | undefined
  const first = await target("target", async (context) => {
    const before = await currentAuthority()
    expect(before.head).toEqual(h0)
    context.native.manifest.startup.settings.clientAuthentication.clients.splice(0, 1)
    const prepared = await prepare(context)
    expired = prepared
    const safe = Authority.describe(prepared)
    expect(safe.identity.deploymentIncarnation).toBe(HomeRestoration.describe(context.permit).incarnation)
    expect(safe.identity.keyID).not.toBe(before.signing.keyID)
    expect(safe.identity.publicKey).not.toBe(before.signing.publicKey)
    expect(safe.checkpoint).toEqual(h0)
    expect(safe.clientDefinitionsHash).toBe(hash(clients))
    const mutable = Authority.describe(prepared)
    mutable.checkpoint.sequence++
    mutable.identity.keyID = "changed-view"
    expect(Authority.describe(prepared)).toEqual(safe)
    expect(await currentAuthority()).toEqual(before)
    expect((await RuntimeMaintenance.status())?.phase).toBe("recovery-held")
    expect(RuntimeContext.isReady()).toBe(false)
    expect(JSON.stringify(safe)).not.toContain("pkcs8")
    expect(() => Authority.describe({ ...prepared })).toThrow("original")
    await Authority.verify(prepared)
    return safe
  })
  if (!expired) throw new Error("Preparation did not return its opaque evidence")
  const closed = expired
  expect(() => Authority.describe(closed)).toThrow("callback")
  const cold = await target("target", async (context) => Authority.describe(await prepare(context)))
  expect(cold).toEqual(first)
  expect(await source.service.maintenance.run(() => AuthorityJournal.head())).toEqual(h1)
}, 15_000)

test("preparation requires the committed import hold rather than installed native files alone", async () => {
  await target(
    "unimported",
    async (context) => {
      await expect(prepare(context)).rejects.toThrow("committed")
      expect(await fs.exists(path.join(context.home, ".synergy", "state", "organization-recovery"))).toBe(false)
    },
    false,
  )
})

test("unknown material publication retries reuse the first key and reject the wrong recovery key", async () => {
  const original = AtomicFile.writeJsonAtomic
  let acknowledged = false
  await target("unknown", async (context) => {
    const intercepted = spyOn(AtomicFile, "writeJsonAtomic").mockImplementation(async (...args) => {
      const result = await original(...args)
      if (String(args[0]).endsWith("signing-material.json")) {
        acknowledged = true
        throw new Error("Lost prepared material acknowledgement")
      }
      return result
    })
    try {
      await expect(prepare(context)).rejects.toThrow("Lost prepared material acknowledgement")
    } finally {
      intercepted.mockRestore()
    }
    expect(acknowledged).toBe(true)
  })
  const first = await target("unknown", async (context) => Authority.describe(await prepare(context)))
  await target("unknown", async (context) => {
    await expect(
      prepare(context, {
        current: keys.current,
        async resolve(version) {
          return version === "material" ? Buffer.alloc(32, 9) : keys.resolve(version)
        },
      }),
    ).rejects.toThrow("authentication")
    expect(Authority.describe(await prepare(context))).toEqual(first)
  })
}, 15_000)

test("a copied encrypted signer cannot be adopted by another Home with the same archive request", async () => {
  const original = await target("original-home", async (context) => {
    const prepared = await prepare(context)
    return { identity: Authority.describe(prepared).identity, ...context }
  })
  await target("foreign-home", async (context) => {
    const from = path.join(original.home, ".synergy", "state", "organization-recovery", original.installationID)
    const to = path.join(context.home, ".synergy", "state", "organization-recovery", context.installationID)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.cp(from, to, { recursive: true })
    await expect(prepare(context)).rejects.toThrow("installation")
    expect((await currentAuthority()).head).toEqual(h0)
  })
}, 15_000)

test("original cancellation during key retrieval publishes no signer or active authority", async () => {
  await target("cancelled", async (context) => {
    const controller = new AbortController()
    const reason = new Error("Original signer preparation cancelled")
    const before = await currentAuthority()
    await expect(
      Authority.prepare({
        permit: context.permit,
        request: input.request,
        native: context.native,
        namespaceDirectory: path.join(path.dirname(input.directory), "records"),
        signal: controller.signal,
        keys: {
          async current() {
            controller.abort(reason)
            return keys.current()
          },
          resolve: keys.resolve,
        },
      }),
    ).rejects.toBe(reason)
    expect(
      await fs.exists(
        path.join(
          context.home,
          ".synergy",
          "state",
          "organization-recovery",
          context.installationID,
          "signing-material.json",
        ),
      ),
    ).toBe(false)
    expect(await currentAuthority()).toEqual(before)
  })
})

test("the original H0 target adopts the real H1 private policy only after its current source is permanently fenced", async () => {
  await target("current-policy", async (context) => {
    const targetRuntime = RuntimeContext.current()
    const before = await currentAuthority()
    const prepared = await prepare(context)
    const identity = Authority.describe(prepared)
    const organization = Record.Info.parse(await Storage.read(Keys.info()))
    const ownerID = organization.owners[0]
    if (!ownerID) throw new Error("The real organization has no owner")
    const expectedAccount = await source.service.maintenance.run(() => Storage.read(Keys.account(ownerID)))
    expect(await Storage.read(Keys.account(ownerID))).not.toEqual(expectedAccount)
    const receipt = await Recovery.withTarget({ ...context, prepared, request: input.request }, (selected) =>
      source.service.maintenance.run(async () => {
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-backup",
          requestID: "current-policy-reconstruction",
          actor: {
            kind: "system",
            subjectID: "operator",
            displayName: "Host operator",
            clientKind: "system",
            requestID: "current-policy-reconstruction",
          },
        })
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
        await Current.withSource(
          { lease, after: h1, directory: path.join(directory, "wrong-policy-anchor"), buildVersion: "fixture", keys },
          async (current) => {
            await expect(Recovery.reconstruct({ source: current, target: selected })).rejects.toThrow(
              "H0 checkpoint anchor",
            )
            expect(await RuntimeMaintenance.retirement(lease.maintenanceID)).toBeUndefined()
            expect(
              (await Bun.file(path.join(source.service.home, ".synergy", "home-ownership.json")).json()).schemaVersion,
            ).toBe(2)
          },
        )
        const result = await Current.withSource(
          { lease, after: h0, directory: path.join(directory, "final-policy"), buildVersion: "fixture", keys },
          async (current) => {
            await expect(Recovery.reconstruct({ source: current, target: { ...selected } })).rejects.toThrow("original")
            const controller = new AbortController()
            const reason = new Error("Original target policy publication cancelled at its last staged receipt")
            let staged = false
            const write = StoreTransaction.prototype.write
            using boundary = spyOn(StoreTransaction.prototype, "write").mockImplementation(async function (
              this: StoreTransaction,
              ...args: Parameters<StoreTransaction["write"]>
            ) {
              await write.apply(this, args)
              if (
                JSON.stringify(args[0]) ===
                JSON.stringify(["organization-recovery", "current-policy", context.installationID])
              ) {
                expect(
                  (await Bun.file(path.join(source.service.home, ".synergy", "home-ownership.json")).json())
                    .schemaVersion,
                ).toBe(4)
                staged = true
                controller.abort(reason)
              }
            })
            await expect(
              Recovery.reconstruct({ source: current, target: selected, signal: controller.signal }),
            ).rejects.toBe(reason)
            expect(staged).toBe(true)
            expect(await targetRuntime.run(() => AuthorityJournal.head())).toEqual(h0)
            expect(await targetRuntime.run(() => Storage.read(Keys.account(ownerID)))).not.toEqual(expectedAccount)
            expect(
              (await Bun.file(path.join(source.service.home, ".synergy", "home-ownership.json")).json()).schemaVersion,
            ).toBe(4)
            boundary.mockRestore()
            const receipt = await Recovery.reconstruct({ source: current, target: selected })
            await targetRuntime.run(() =>
              RuntimeMaintenance.restorationTransaction(
                { permit: context.permit, request: input.request },
                async (tx) => {
                  const account = Record.Account.parse(await Storage.read(Keys.account(ownerID)))
                  await tx.write(Keys.account(ownerID), {
                    ...account,
                    displayName: "Target-only name outside the redacted projection",
                  })
                },
              ),
            )
            expect((await targetRuntime.run(() => AuthorityJournal.inspect())).covered).toBe(true)
            expect(await Recovery.reconstruct({ source: current, target: selected })).toEqual(receipt)
            expect(await targetRuntime.run(() => Storage.read(Keys.account(ownerID)))).toEqual(expectedAccount)
            return receipt
          },
        )
        await expect(RuntimeMaintenance.release(lease)).rejects.toThrow("retirement")
        return result
      }),
    )
    expect(receipt.checkpoint).toEqual(h1)
    expect(receipt.target).toEqual(identity.reference)
    expect(await Storage.read(Keys.account(ownerID))).toEqual(expectedAccount)
    expect(await AuthorityJournal.head()).toEqual(h1)
    expect((await AuthorityJournal.inspect()).covered).toBe(true)
    expect((await RuntimeMaintenance.status())?.phase).toBe("recovery-held")
    expect(RuntimeContext.isReady()).toBe(false)
    const after = await currentAuthority()
    expect(after.deployment).toEqual(before.deployment)
    expect(after.signing).toEqual(before.signing)
    expect(after.authHash).toEqual(before.authHash)
    expect(Authority.describe(prepared)).toEqual(identity)
    expect(await Bun.file(path.join(source.service.home, ".synergy", "home-ownership.json")).json()).toMatchObject({
      schemaVersion: 4,
    })
  })
}, 20_000)
