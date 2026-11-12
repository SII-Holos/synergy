import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { FileAtomicWrite } from "@ericsanchezok/synergy-local-runtime/file/atomic-write"
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
import { openOrganizationRecovery, openOrganizationSourceRetirement } from "../../src/service"
import { OrganizationSourceRetirement as Retirement } from "../../src/backup/source-retirement"
import * as Signing from "../../src/signing"
import { openOrganizationService } from "../../src/service"
import { ORGANIZATION_CONFIG_FILENAME } from "../../src/config-schema"
import { OrganizationIdentity } from "@ericsanchezok/synergy-organization-protocol"
import { authenticateHuman } from "../../src/auth/session"
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

async function captureFixture(change: "password" | "project" = "password") {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "recovery-authority-")),
  )
  const source = await organizationFixture(undefined, { clientAuthentication: { clients } })
  const owner = await source.initialize()
  const login = await source.service.fetch(
    new Request("https://organization.example/org/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://organization.example" },
      body: JSON.stringify({ loginName: "owner", password }),
    }),
  )
  expect(login.status).toBe(200)
  const cookie = login.headers.get("set-cookie")?.split(";")[0]
  if (!cookie) throw new Error("The original service did not retain its actual login cookie")
  const payload = Buffer.from("Canonical service-only recovery bytes")
  const payloadKey = ["organization", "recovery-proof", "bytes"]
  if (change === "project") await source.service.maintenance.run(() => Storage.writeBinary(payloadKey, payload))
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
  const h0 = await source.service.maintenance.run(() => AuthorityJournal.head())
  const changed =
    change === "password"
      ? await owner.request("POST", "/auth/password", {
          currentPassword: password,
          password: "new source password after checkpoint",
        })
      : await owner.request("POST", "/projects", { name: "Current policy project" })
  expect(changed.status).toBe(200)
  const project = change === "project" ? OrganizationIdentity.ProjectView.parse(await changed.json()) : undefined
  if (change === "project") {
    const config = path.join(source.service.home, ".synergy", "config", "synergy.d", ORGANIZATION_CONFIG_FILENAME)
    await fs.mkdir(path.dirname(config), { recursive: true })
    await fs.writeFile(
      config,
      JSON.stringify({
        organization: {
          clientAuthentication: { clients: [{ ...clients[0], clientID: "not-the-effective-runtime-client" }] },
        },
      }),
    )
  }
  const h1 = await source.service.maintenance.run(() => AuthorityJournal.head())
  const opened = path.join(directory, "opened")
  await Archive.open({ directory: encrypted, outputDirectory: opened, keys: sourceKeys })
  const base = path.join(opened, "namespaces", "0000000000000000")
  const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
  if (!inventory.native) throw new Error("Service native facet is missing")
  const snapshot = inventory.segment.namespace
  const input: Omit<Parameters<typeof Native.withInstalled>[0], "permit"> = {
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
  return {
    directory,
    source,
    input,
    snapshot,
    h0,
    h1,
    cookie,
    project,
    payloadKey,
    payloadHash: createHash("sha256").update(payload).digest("hex"),
  }
}
beforeAll(async () => {
  const captured = await captureFixture()
  directory = captured.directory
  source = captured.source
  input = captured.input
  snapshot = captured.snapshot
  h0 = captured.h0
  h1 = captured.h1
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
async function target<T>(
  name: string,
  body: (context: InstalledContext) => Promise<T>,
  restore = true,
  captured = { directory, input, snapshot },
) {
  const original = captured.input
  const home = path.join(captured.directory, name)
  await using runtime = await openOrganizationRecovery({ home })
  return runtime.run(async () => {
    const selected = await HomeRestoration.begin(original.request)
    return HomeRestoration.withTarget(selected, (permit) =>
      Native.withInstalled({ ...original, permit }, (native) =>
        SnapshotMaintenance.withInstalledSegment(
          {
            directory: path.join(path.dirname(original.directory), "snapshots"),
            namespaceDirectory: path.join(path.dirname(original.directory), "records"),
            source: original.source,
            expected: captured.snapshot,
            keys,
            permit,
            request: original.request,
          },
          async (installed) => {
            if (restore)
              await StorageCheckpoint.restoreArchive({
                directory: path.join(path.dirname(original.directory), "records"),
                expected: original.source,
                keys,
                restoreID: original.request.restoreID,
                finalize: (tx, archive) =>
                  Native.adoptRestoration(tx, {
                    permit,
                    request: original.request,
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

test("closed source and target callbacks reconstruct fixed H1 policy cold without replacing inactive material", async () => {
  const captured = await captureFixture("project")
  const finalDirectory = path.join(captured.directory, "final-policy")
  let coldSource: Awaited<ReturnType<typeof openOrganizationSourceRetirement>> | undefined
  try {
    const original = await target(
      "cold-target",
      async (context) => {
        const prepared = await Authority.prepare({
          permit: context.permit,
          native: context.native,
          request: captured.input.request,
          namespaceDirectory: path.join(path.dirname(captured.input.directory), "records"),
          keys,
        })
        const info = Authority.describe(prepared)
        const materialFile = path.join(
          context.home,
          ".synergy",
          "state",
          "organization-recovery",
          context.installationID,
          "signing-material.json",
        )
        const material = await fs.readFile(materialFile)
        const accountID = Record.Info.parse(await Storage.read(Keys.info())).owners[0]
        if (!accountID) throw new Error("The original target has no owner")
        const factKey = captured.project ? Keys.project(captured.project.projectID) : Keys.account(accountID)
        const account = await captured.source.service.maintenance.run(() => Storage.read(factKey))
        const reference = await captured.source.service.maintenance.run(async () => {
          const lease = await RuntimeMaintenance.begin({
            purpose: "organization-backup",
            requestID: "cold-policy",
            actor: {
              kind: "system",
              subjectID: "operator",
              displayName: "Host",
              clientKind: "system",
              requestID: "cold-policy",
            },
          })
          await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
          return Current.withSource(
            { lease, after: captured.h0, directory: finalDirectory, buildVersion: "fixture", keys },
            async (source) => {
              const reference = await Current.retirementReference(source, info.reference)
              await Current.retire(source, reference)
              return reference
            },
          )
        })
        expect(await AuthorityJournal.head()).toEqual(captured.h0)
        return { reference, info, materialFile, material, accountID, account, factKey }
      },
      true,
      captured,
    )
    await captured.source.service.close()
    const namespace = {
      directory: path.join(finalDirectory, "records"),
      expected: StorageCheckpoint.Manifest.parse(
        await Bun.file(path.join(finalDirectory, "records", "manifest.json")).json(),
      ),
    }
    const native = {
      directory: path.join(finalDirectory, "native"),
      expected: StorageCheckpoint.Manifest.parse(
        await Bun.file(path.join(finalDirectory, "native", "manifest.json")).json(),
      ),
    }
    let freshKeyRequests = 0
    const readKeys = {
      async current() {
        freshKeyRequests++
        throw new Error("Cold reconstruction must not generate recovery material")
      },
      resolve: keys.resolve,
    }
    using generation = spyOn(Signing, "prepareSigningMaterial")
    coldSource = await openOrganizationSourceRetirement({
      home: captured.source.service.home,
      reference: original.reference,
    })
    const firstSource = coldSource
    const physical = await firstSource.complete()
    const inspection: { guard?: () => void } = {}
    await firstSource.run(() =>
      Retirement.withVerified(physical, async (verified) => {
        verified.assertLive()
        inspection.guard = verified.assertLive
      }),
    )
    const guard = inspection.guard
    if (!guard) throw new Error("The actual cold source did not issue its inspection lifetime")
    expect(guard).toThrow("callback")
    const receipt = await target(
      "cold-target",
      async (context) => {
        const prepared = await Authority.reopen({
          permit: context.permit,
          native: context.native,
          request: captured.input.request,
          namespaceDirectory: path.join(path.dirname(captured.input.directory), "records"),
          keys: readKeys,
        })
        expect(Authority.describe(prepared)).toEqual(original.info)
        return Recovery.withTarget({ ...context, prepared, request: captured.input.request }, async (selected) => {
          await expect(
            firstSource.run(() =>
              Recovery.reconstructCold({
                source: { ...physical },
                target: selected,
                namespace,
                native,
                keys: readKeys,
              }),
            ),
          ).rejects.toThrow("original")
          await expect(
            firstSource.run(() =>
              Recovery.reconstructCold({
                source: physical,
                target: selected,
                namespace: { ...namespace, expected: { ...namespace.expected, archiveID: "another-archive" } },
                native,
                keys: readKeys,
              }),
            ),
          ).rejects.toThrow("hashes")
          const controller = new AbortController()
          const reason = new Error("Cold H1 target publication cancelled at last receipt")
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
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
              entered.resolve()
              await release.promise
              controller.abort(reason)
            }
          })
          const accepted = await firstSource.run(async () => ({
            work: Recovery.reconstructCold({
              source: physical,
              target: selected,
              namespace,
              native,
              keys: readKeys,
              signal: controller.signal,
            }).then(
              (value) => ({ kind: "success" as const, value }),
              (error: unknown) => ({ kind: "failure" as const, error }),
            ),
          }))
          try {
            await Promise.race([
              entered.promise,
              accepted.work.then(() => {
                throw new Error("Cold reconstruction ended before its final write")
              }),
            ])
            let closed = false
            const closing = firstSource.close().then(() => {
              closed = true
            })
            await Promise.resolve()
            expect(closed).toBe(false)
            release.resolve()
            const outcome = await accepted.work
            if (outcome.kind !== "failure") throw new Error("Cancelled cold reconstruction unexpectedly committed")
            expect(outcome.error).toBe(reason)
            await closing
          } finally {
            release.resolve()
            await accepted.work
          }
          expect(await AuthorityJournal.head()).toEqual(captured.h0)
          expect((await Storage.readMany([original.factKey]))[0]).not.toEqual(original.account)
          boundary.mockRestore()
          coldSource = await openOrganizationSourceRetirement({
            home: captured.source.service.home,
            reference: original.reference,
          })
          const resumed = coldSource
          const resumedPhysical = await resumed.complete()
          const receipt = await resumed.run(() =>
            Recovery.reconstructCold({ source: resumedPhysical, target: selected, namespace, native, keys: readKeys }),
          )
          expect(await AuthorityJournal.head()).toEqual(captured.h1)
          expect(await Storage.read(original.factKey)).toEqual(original.account)
          return receipt
        })
      },
      false,
      captured,
    )
    await coldSource.close()
    coldSource = await openOrganizationSourceRetirement({
      home: captured.source.service.home,
      reference: original.reference,
    })
    const secondSource = coldSource
    const reopenedPhysical = await secondSource.complete()
    await target(
      "cold-target",
      async (context) => {
        const prepared = await Authority.reopen({
          permit: context.permit,
          native: context.native,
          request: captured.input.request,
          namespaceDirectory: path.join(path.dirname(captured.input.directory), "records"),
          keys: readKeys,
        })
        expect(Authority.describe(prepared)).toEqual(original.info)
        await Recovery.withTarget({ ...context, prepared, request: captured.input.request }, async (selected) => {
          expect(
            await secondSource.run(() =>
              Recovery.reconstructCold({
                source: reopenedPhysical,
                target: selected,
                namespace,
                native,
                keys: readKeys,
              }),
            ),
          ).toEqual(receipt)
        })
        expect((await RuntimeMaintenance.status())?.phase).toBe("recovery-held")
        expect(RuntimeContext.isReady()).toBe(false)
        expect(await fs.readFile(original.materialFile)).toEqual(original.material)
        await fs.rename(original.materialFile, original.materialFile + ".missing")
        try {
          await expect(
            Authority.reopen({
              permit: context.permit,
              native: context.native,
              request: captured.input.request,
              namespaceDirectory: path.join(path.dirname(captured.input.directory), "records"),
              keys: readKeys,
            }),
          ).rejects.toThrow("existing inactive")
          await expect(
            Authority.prepare({
              permit: context.permit,
              native: context.native,
              request: captured.input.request,
              namespaceDirectory: path.join(path.dirname(captured.input.directory), "records"),
              keys: readKeys,
            }),
          ).rejects.toThrow("historical checkpoint")
          expect(await fs.exists(original.materialFile)).toBe(false)
        } finally {
          await fs.rename(original.materialFile + ".missing", original.materialFile)
        }
        const token = captured.cookie.split("=").slice(1).join("=")
        expect((await authenticateHuman({ token })).account.accountID).toBe(original.accountID)
        const publicationKey = ["organization-recovery", "publication", original.info.reference.installationID]
        const cancelled = new AbortController()
        const reason = new Error("Fresh authority publication cancelled after the actual last write")
        const actualWrite = StoreTransaction.prototype.write
        using lastPublication = spyOn(StoreTransaction.prototype, "write").mockImplementation(async function (
          this: StoreTransaction,
          ...args: Parameters<StoreTransaction["write"]>
        ) {
          await actualWrite.apply(this, args)
          if (JSON.stringify(args[0]) === JSON.stringify(publicationKey)) cancelled.abort(reason)
        })
        await expect(
          Recovery.withTarget({ ...context, prepared, request: captured.input.request }, (selected) =>
            secondSource.run(() =>
              Recovery.publishServiceOnly({
                source: reopenedPhysical,
                target: selected,
                namespace,
                native,
                keys: readKeys,
                publicOrigin: "https://recovered.example",
                signal: cancelled.signal,
              }),
            ),
          ),
        ).rejects.toBe(reason)
        expect((await Storage.readMany([publicationKey]))[0]).toBeUndefined()
        expect((await authenticateHuman({ token })).account.accountID).toBe(original.accountID)
        expect(await fs.readFile(original.materialFile)).toEqual(original.material)
        lastPublication.mockRestore()
        const observer = new AbortController()
        await Recovery.withTarget({ ...context, prepared, request: captured.input.request }, async (selected) => {
          const input = {
            source: reopenedPhysical,
            target: selected,
            namespace,
            native,
            keys: readKeys,
            publicOrigin: "https://recovered.example",
            signal: observer.signal,
          }
          const publication = await secondSource.run(() => Recovery.publishServiceOnly(input))
          expect(await secondSource.run(() => Recovery.publishServiceOnly(input))).toEqual(publication)
        })
        observer.abort(new Error("Original publication observer has left after commit"))
      },
      false,
      captured,
    )
    expect(generation).toHaveBeenCalledTimes(0)
    expect(freshKeyRequests).toBe(0)
    await secondSource.close()
    const swappingCompletion = await openOrganizationRecovery({ home: path.join(captured.directory, "cold-target") })
    const root = path.join(captured.directory, "cold-target", ".synergy")
    const retainedRoot = root + ".before-settings"
    const config = path.join(root, "config", "synergy.d", ORGANIZATION_CONFIG_FILENAME)
    const sentinel = JSON.stringify({ organization: { connections: { heartbeatMs: 16000, offlineMs: 64000 } } })
    const writeSettings = FileAtomicWrite.write
    let moved = false
    let replacementValue: string | undefined
    const verifyPublication = HomeRestoration.verifyPublication
    using restoreAfterActualRefusal = spyOn(HomeRestoration, "verifyPublication").mockImplementation(
      async (...args: Parameters<typeof HomeRestoration.verifyPublication>) => {
        try {
          return await verifyPublication(...args)
        } catch (error) {
          if (moved) {
            replacementValue = await fs.readFile(config, "utf8")
            await fs.rm(root, { recursive: true, force: true })
            await fs.rename(retainedRoot, root)
            moved = false
          }
          throw error
        }
      },
    )
    using swapConfigRoot = spyOn(FileAtomicWrite, "write").mockImplementation(
      async (...args: Parameters<typeof FileAtomicWrite.write>) => {
        if (args[1].at(-1) === ORGANIZATION_CONFIG_FILENAME && !moved) {
          await fs.rename(root, retainedRoot)
          moved = true
          await fs.mkdir(path.dirname(config), { recursive: true })
          await fs.writeFile(config, sentinel)
        }
        return writeSettings(...args)
      },
    )
    try {
      await expect(
        swappingCompletion.run(() => Recovery.completeServicePublication(original.info.reference.installationID)),
      ).rejects.toThrow(/Installation target native identity/)
      expect(replacementValue).toBe(sentinel)
    } finally {
      swapConfigRoot.mockRestore()
      restoreAfterActualRefusal.mockRestore()
      if (moved) {
        await fs.rm(root, { recursive: true, force: true })
        await fs.rename(retainedRoot, root)
      }
      await swappingCompletion.close().catch(() => {})
    }
    const failedCompletion = await openOrganizationRecovery({ home: path.join(captured.directory, "cold-target") })
    const lostSettingsReply = new Error("Current native settings were written but acknowledgement was lost")
    const publishSettings = FileAtomicWrite.write
    using lostNativeReply = spyOn(FileAtomicWrite, "write").mockImplementation(
      async (...args: Parameters<typeof FileAtomicWrite.write>) => {
        const result = await publishSettings(...args)
        if (args[1].at(-1) === ORGANIZATION_CONFIG_FILENAME) throw lostSettingsReply
        return result
      },
    )
    await expect(
      failedCompletion.run(() => Recovery.completeServicePublication(original.info.reference.installationID)),
    ).rejects.toBe(lostSettingsReply)
    await expect(failedCompletion.close()).rejects.toThrow("Organization service cleanup failed")
    lostNativeReply.mockRestore()
    await expect(
      openOrganizationService({
        home: path.join(captured.directory, "cold-target"),
        publicOrigin: "https://recovered.example",
      }),
    ).rejects.toThrow("incomplete")
    await using completion = await openOrganizationRecovery({ home: path.join(captured.directory, "cold-target") })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const writeFile = FileAtomicWrite.write
    using nativeSettings = spyOn(FileAtomicWrite, "write").mockImplementation(
      async (...args: Parameters<typeof FileAtomicWrite.write>) => {
        if (args[1].at(-1) === ORGANIZATION_CONFIG_FILENAME) {
          entered.resolve()
          await release.promise
        }
        return writeFile(...args)
      },
    )
    const accepted = await completion.run(async () => ({
      work: Recovery.completeServicePublication(original.info.reference.installationID),
    }))
    try {
      await Promise.race([
        entered.promise,
        accepted.work.then(() => {
          throw new Error("Native completion ended before its actual settings write")
        }),
      ])
      let closed = false
      const closing = completion.close().then(() => {
        closed = true
      })
      await Promise.resolve()
      expect(closed).toBe(false)
      release.resolve()
      await accepted.work
      await closing
    } finally {
      release.resolve()
      await accepted.work
    }
    nativeSettings.mockRestore()
    await using normal = await openOrganizationService({
      home: path.join(captured.directory, "cold-target"),
      publicOrigin: "https://recovered.example",
    })
    expect((await normal.deployment()).deploymentIncarnation).toBe(original.info.identity.deploymentIncarnation)
    expect(
      (
        await normal.fetch(
          new Request("https://recovered.example/org/v1/auth/session", { headers: { cookie: captured.cookie } }),
        )
      ).status,
    ).toBe(401)
    const login = await normal.fetch(
      new Request("https://recovered.example/org/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://recovered.example" },
        body: JSON.stringify({ loginName: "owner", password }),
      }),
    )
    expect(login.status).toBe(200)
    const currentLogin = OrganizationIdentity.LoginResult.parse(await login.json())
    const cookie = login.headers.get("set-cookie")?.split(";")[0]
    const authority = await normal.deployment()
    const authorize = await normal.fetch(
      new Request("https://recovered.example/org/v1/auth/authorize", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://recovered.example",
          cookie: cookie ?? "",
          "x-csrf-token": currentLogin.csrfToken,
        },
        body: JSON.stringify({
          issuer: "https://recovered.example",
          orgID: authority.orgID,
          deploymentIncarnation: authority.deploymentIncarnation,
          clientID: "desktop",
          redirectUri: "synergy://organization-auth/callback",
          codeChallenge: createHash("sha256").update("recovery-verifier").digest("base64url"),
          codeChallengeMethod: "S256",
          state: createHash("sha256").update("recovery-state").digest("base64url"),
        }),
      }),
    )
    expect(authorize.status).toBe(200)
    await expect(
      normal.maintenance.run(() =>
        Storage.write(["organization-recovery", "publication", original.info.reference.installationID], {}),
      ),
    ).rejects.toThrow("owning publication")
    const bytes = await normal.maintenance.run(() => Storage.readBinary(captured.payloadKey))
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(captured.payloadHash)
    expect((await normal.capabilities()).executesAgents).toBe(false)
    await normal.maintenance.run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: "after-restored-publication",
        actor: {
          kind: "system",
          subjectID: "operator",
          displayName: "Host operator",
          clientKind: "system",
          requestID: "after-restored-publication",
        },
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      await RuntimeMaintenance.release(lease)
    })
    await normal.close()
    const filename = path.join(
      captured.directory,
      "cold-target",
      ".synergy",
      "config",
      "synergy.d",
      ORGANIZATION_CONFIG_FILENAME,
    )
    await AtomicFile.writeJsonAtomic(
      filename,
      JSON.stringify({
        organization: { clientAuthentication: { clients }, connections: { heartbeatMs: 15000, offlineMs: 60000 } },
      }),
      { durable: true, private: true },
    )
    await using changed = await openOrganizationService({
      home: path.join(captured.directory, "cold-target"),
      publicOrigin: "https://recovered.example",
    })
    expect((await changed.deployment()).deploymentIncarnation).toBe(original.info.identity.deploymentIncarnation)
    await changed.maintenance.run(() => Recovery.completeServicePublication(original.info.reference.installationID))
    const configAfterRetry = JSON.parse(await fs.readFile(filename, "utf8"))
    expect(configAfterRetry.organization.connections.heartbeatMs).toBe(15000)
  } finally {
    await coldSource?.close()
    await captured.source[Symbol.asyncDispose]()
    await fs.rm(captured.directory, { recursive: true, force: true })
  }
}, 20_000)
