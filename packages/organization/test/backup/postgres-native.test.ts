import { expect, test } from "bun:test"
import { SQL } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { OrganizationBackupCohort as Cohort } from "../../src/backup/cohort"
import { OrganizationRecoveryArchive as Archive } from "../../src/backup/archive"
import { OrganizationServiceNative as Native } from "../../src/backup/service-native"
import { OrganizationRecoveryDatabase as Database } from "../../src/backup/database"
import { OrganizationRecoveryAuthority as Authority } from "../../src/backup/authority"
import { OrganizationCurrentAuthority as Current } from "../../src/backup/current-authority"
import { OrganizationRecovery as Recovery } from "../../src/backup/recovery"
import { openOrganizationRecovery, openOrganizationService, openOrganizationSourceRetirement } from "../../src/service"
import { fixture } from "../support/organization"

const postgres = test.skipIf(!process.env.SYNERGY_TEST_POSTGRES_URL)
const keys = {
  async current() {
    return { version: "postgres-recovery", key: Buffer.alloc(32, 31) }
  },
  async resolve() {
    return Buffer.alloc(32, 31)
  },
}
const actor = {
  kind: "system" as const,
  subjectID: "native-database-operator",
  displayName: "Database operator",
  clientKind: "system" as const,
  requestID: "postgres-recovery",
}

postgres(
  "PostgreSQL recovery keeps its backend and fresh namespace through independent cold publication",
  async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "postgres-native-")))
    const database = {
      backend: "postgres" as const,
      url: process.env.SYNERGY_TEST_POSTGRES_URL!,
      namespace: "source_" + crypto.randomUUID().replaceAll("-", ""),
    }
    const targetDatabase = { ...database, namespace: "target_" + crypto.randomUUID().replaceAll("-", "") }
    await using source = await fixture(undefined, { database })
    const owner = await source.initialize()
    const oldLogin = await owner.login("owner")
    const oldCookie = oldLogin.headers.get("set-cookie")!.split(";")[0]!
    const bytes = Buffer.from("PostgreSQL original native bytes\u0000\u00ff")
    const address = ["organization", "recovery-proof", "postgres"]
    await source.service.maintenance.run(() => Storage.writeBinary(address, bytes))
    try {
      const encrypted = path.join(directory, "encrypted")
      const report = await Cohort.capture({
        service: Cohort.service(source.service.maintenance),
        async resolve() {
          throw new Error("This PostgreSQL fixture has no Hosted participant")
        },
        directory: encrypted,
        archiveID: "postgres-native",
        buildVersion: "fixture",
        keys,
        actor,
      })
      const h0 = await source.service.maintenance.run(() => AuthorityJournal.head())
      expect(
        (
          await owner.request("POST", "/auth/password", {
            currentPassword: "correct horse battery staple",
            password: "PostgreSQL H1 current password",
          })
        ).status,
      ).toBe(200)
      const opened = path.join(directory, "opened")
      await Archive.open({ directory: encrypted, outputDirectory: opened, keys })
      const base = path.join(opened, "namespaces", "0000000000000000")
      const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
      if (!inventory.native) throw new Error("PostgreSQL Service native facet is missing")
      const request = Native.installationRequest({
        restoreID: "postgres-independent-native",
        source: inventory.namespace,
        expected: inventory.native,
        snapshot: inventory.segment.namespace,
        cohort: {
          archiveID: report.archiveID,
          pagesHash: report.pagesHash,
          ordinal: inventory.ordinal,
          source: { orgID: inventory.identity.orgID, deploymentIncarnation: inventory.identity.deploymentIncarnation },
        },
      })
      const input = {
        directory: path.join(base, "native"),
        expected: inventory.native,
        source: inventory.namespace,
        keys,
        request,
      }
      const metadata = await Native.verify(input)
      expect(metadata.startup.database).toEqual({ version: 1, backend: "postgres", namespace: database.namespace })
      expect(JSON.stringify(metadata)).not.toContain(database.url)
      const wrongHome = path.join(directory, "wrong-backend")
      await using wrong = await openOrganizationRecovery({ home: wrongHome })
      await wrong.run(async () => {
        const installation = await HomeRestoration.begin(request)
        await HomeRestoration.withTarget(installation, async (permit) => {
          await expect(Native.withInstalled({ ...input, permit }, async () => {})).rejects.toThrow("database backend")
          expect(await fs.exists(path.join(wrongHome, ".synergy", "home-ownership.json"))).toBe(false)
        })
      })
      const home = path.join(directory, "target")
      async function withTarget<T>(
        restore: boolean,
        body: (context: {
          permit: HomeRestoration.InstallPermit
          native: Native.Installed
          installationID: string
        }) => Promise<T>,
      ) {
        await using target = await openOrganizationRecovery({ home, database: targetDatabase })
        return await target.run(async () => {
          const installation = await HomeRestoration.begin(request)
          return HomeRestoration.withTarget(installation, (permit) =>
            Native.withInstalled({ ...input, permit }, (native) =>
              SnapshotMaintenance.withInstalledSegment(
                {
                  directory: path.join(base, "snapshots"),
                  namespaceDirectory: path.join(base, "records"),
                  source: inventory.namespace,
                  expected: inventory.segment.namespace,
                  keys,
                  permit,
                  request,
                },
                async (snapshot) => {
                  expect(() =>
                    Database.assertTarget({ version: 1, backend: "postgres", namespace: targetDatabase.namespace }),
                  ).toThrow("fresh PostgreSQL namespace")
                  if (restore)
                    await StorageCheckpoint.restoreArchive({
                      directory: path.join(base, "records"),
                      expected: inventory.namespace,
                      keys,
                      restoreID: request.restoreID,
                      finalize: (tx, archive) =>
                        Native.adoptRestoration(tx, { permit, request, native, snapshot, archive }).then(() => {}),
                    })
                  expect(Storage.current().store.options).toMatchObject({
                    backend: "postgres",
                    namespace: targetDatabase.namespace,
                  })
                  expect(RuntimeContext.isReady()).toBe(false)
                  return body({ permit, native, installationID: HomeRestoration.describe(permit).installationID })
                },
              ),
            ),
          )
        })
      }
      const h1 = path.join(directory, "h1")
      const original = await withTarget(true, async (context) => {
        const prepared = await Authority.prepare({
          ...context,
          request,
          namespaceDirectory: path.join(base, "records"),
          keys,
        })
        const info = Authority.describe(prepared)
        expect(await Storage.readBinary(address)).toEqual(bytes)
        const reference = await source.service.maintenance.run(async () => {
          const lease = await RuntimeMaintenance.begin({
            purpose: "organization-backup",
            requestID: "postgres-h1",
            actor: { ...actor, requestID: "postgres-h1" },
          })
          await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
          return Current.withSource(
            { lease, after: h0, directory: h1, buildVersion: "fixture", keys },
            async (current) => {
              const reference = await Current.retirementReference(current, info.reference)
              await Current.retire(current, reference)
              return reference
            },
          )
        })
        return { reference, info, installationID: context.installationID }
      })
      await source.service.close()
      await using substituted = await openOrganizationRecovery({
        home,
        database: { ...targetDatabase, namespace: "other_" + crypto.randomUUID().replaceAll("-", "") },
      })
      await substituted.run(async () => {
        await expect(HomeRestoration.begin(request)).rejects.toThrow("different restoration request")
      })
      await substituted.close()
      await expect(openOrganizationService({ home: source.service.home, database })).rejects.toBeInstanceOf(
        HomeOwnershipFile.Error,
      )
      expect(await Bun.file(path.join(source.service.home, ".synergy", "home-ownership.json")).json()).toMatchObject({
        schemaVersion: 4,
      })
      await expect(openOrganizationService({ home, database: targetDatabase })).rejects.toThrow("restoration")
      const namespace = {
        directory: path.join(h1, "records"),
        expected: StorageCheckpoint.Manifest.parse(await Bun.file(path.join(h1, "records", "manifest.json")).json()),
      }
      const native = {
        directory: path.join(h1, "native"),
        expected: StorageCheckpoint.Manifest.parse(await Bun.file(path.join(h1, "native", "manifest.json")).json()),
      }
      const foreignNamespace = "unopened_" + crypto.randomUUID().replaceAll("-", "")
      await expect(
        openOrganizationSourceRetirement({
          home: source.service.home,
          database: { ...database, namespace: foreignNamespace },
          reference: original.reference,
        }),
      ).rejects.toThrow("original primary Store configuration")
      const inspector = new SQL(database.url)
      try {
        expect(await inspector`SELECT namespace FROM storage_namespaces WHERE namespace = ${foreignNamespace}`).toEqual(
          [],
        )
      } finally {
        await inspector.close()
      }
      await using physicalSource = await openOrganizationSourceRetirement({
        home: source.service.home,
        database,
        reference: original.reference,
      })
      const physical = await physicalSource.complete()
      await withTarget(false, async (context) => {
        const prepared = await Authority.reopen({
          ...context,
          request,
          namespaceDirectory: path.join(base, "records"),
          keys,
        })
        expect(Authority.describe(prepared)).toEqual(original.info)
        await Recovery.withTarget({ ...context, prepared, request }, (target) =>
          physicalSource.run(() =>
            Recovery.publishServiceOnly({
              source: physical,
              target,
              namespace,
              native,
              keys,
              publicOrigin: "https://postgres-recovered.example",
            }),
          ),
        )
      })
      await physicalSource.close()
      await using completion = await openOrganizationRecovery({ home, database: targetDatabase })
      await completion.run(() => Recovery.completeServicePublication(original.installationID))
      await completion.close()
      await using normal = await openOrganizationService({
        home,
        database: targetDatabase,
        publicOrigin: "https://postgres-recovered.example",
      })
      expect((await normal.fetch(new Request("https://postgres-recovered.example/org/v1/ready"))).status).toBe(200)
      await expect(
        openOrganizationService({
          home,
          database: targetDatabase,
          cloud: { environmentProfiles: { future: { provider: "not-admitted-by-this-reader", spec: {} } } },
        }),
      ).rejects.toBeInstanceOf(HomeOwnershipFile.Error)
      expect(
        (
          await normal.fetch(
            new Request("https://postgres-recovered.example/org/v1/auth/session", { headers: { cookie: oldCookie } }),
          )
        ).status,
      ).toBe(401)
      const login = await normal.fetch(
        new Request("https://postgres-recovered.example/org/v1/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://postgres-recovered.example" },
          body: JSON.stringify({ loginName: "owner", password: "PostgreSQL H1 current password" }),
        }),
      )
      expect(login.status).toBe(200)
      expect(await normal.maintenance.run(() => Storage.readBinary(address))).toEqual(bytes)
      expect(await fs.exists(path.join(home, ".synergy", "data", "organization.sqlite"))).toBe(false)
      expect((await normal.deployment()).deploymentIncarnation).toBe(original.info.identity.deploymentIncarnation)
    } finally {
      await source.service.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
  30_000,
)
