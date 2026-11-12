import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { OrganizationBackupCohort as Cohort } from "../../src/backup/cohort"
import { OrganizationRecoveryArchive as Archive } from "../../src/backup/archive"
import { OrganizationServiceNative as Native } from "../../src/backup/service-native"
import { openOrganizationRecovery, openOrganizationService } from "../../src/service"
import { parseOrganizationConfiguration, readOrganizationConfigurationSnapshot } from "../../src/configuration"
import { OrganizationServiceHome } from "../../src/service-home"
import { ORGANIZATION_CONFIG_FILENAME } from "../../src/config-schema"

const keys = {
  async current() {
    return { version: "native-install", key: Buffer.alloc(32, 7) }
  },
  async resolve() {
    return Buffer.alloc(32, 7)
  },
}
const actor = {
  kind: "system" as const,
  subjectID: "host-operator",
  displayName: "Host operator",
  clientKind: "system" as const,
  requestID: "native-install",
}
async function fixture() {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "service-native-install-")),
  )
  const home = path.join(directory, "source")
  const raw = Buffer.from('{\n // captured comment\n "organization": { "authentication": { "loginMs": 123456 } }\n}\n')
  const filename = path.join(home, ".synergy", "config", "synergy.d", ORGANIZATION_CONFIG_FILENAME)
  await fs.mkdir(path.dirname(filename), { recursive: true })
  await fs.writeFile(filename, raw)
  const service = await openOrganizationService({ home })
  const archive = path.join(directory, "encrypted")
  const report = await Cohort.capture({
    service: Cohort.service(service.maintenance),
    async resolve() {
      throw new Error("This fixture has no Hosted participant")
    },
    directory: archive,
    archiveID: "native-install",
    buildVersion: "fixture",
    keys,
    actor,
  })
  await service.close()
  const opened = path.join(directory, "opened")
  await Archive.open({ directory: archive, outputDirectory: opened, keys })
  const base = path.join(opened, "namespaces", "0000000000000000")
  const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
  if (!inventory.native) throw new Error("Service native segment is missing")
  const request = Native.installationRequest({
    restoreID: "service-native-install",
    source: inventory.namespace,
    expected: inventory.native,
    cohort: {
      archiveID: report.archiveID,
      pagesHash: report.pagesHash,
      ordinal: inventory.ordinal,
      source: { orgID: inventory.identity.orgID, deploymentIncarnation: inventory.identity.deploymentIncarnation },
    },
  })
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(archive, { recursive: true, force: true })
  return {
    directory,
    raw,
    input: {
      directory: path.join(base, "native"),
      expected: inventory.native,
      source: inventory.namespace,
      keys,
      request,
    },
    request,
  }
}

test("service native installation publishes permanent recovery ownership before configuration and survives a cold restricted reader", async () => {
  const f = await fixture()
  const home = path.join(f.directory, "target")
  let incarnation = ""
  try {
    const target = await openOrganizationRecovery({ home })
    try {
      await target.run(async () => {
        const install = await HomeRestoration.begin(f.request)
        incarnation = (await HomeRestoration.inspect(install)).incarnation
        await HomeRestoration.withTarget(install, async (permit) => {
          let observed = false
          const write = AtomicFile.writeFileAtomic
          const intercepted = spyOn(AtomicFile, "writeFileAtomic").mockImplementation(async (...args) => {
            if (path.basename(String(args[0])) === ORGANIZATION_CONFIG_FILENAME) {
              const fence = await Bun.file(path.join(home, ".synergy", "home-ownership.json")).json()
              expect(fence).toMatchObject({
                schemaVersion: 3,
                incarnation,
                readerContract: OrganizationServiceHome.recoveryReaderContract,
              })
              observed = true
            }
            return write(...args)
          })
          try {
            let expired: Native.Installed | undefined
            await Native.withInstalled({ ...f.input, permit }, async (installed) => {
              expired = installed
              await installed.verify()
              Native.assertInstalled(installed)
              await Native.verifyInstalled(installed)
              expect(() => Native.assertInstalled({ ...installed })).toThrow("original native")
              expect(installed.manifest.startup.publicOrigin).toBeUndefined()
              expect(await readOrganizationConfigurationSnapshot(home)).toMatchObject({
                present: true,
                bytes: f.raw,
                settings: { authentication: { loginMs: 123456 } },
              })
            })
            if (!expired) throw new Error("Installed native callback was not entered")
            const closed = expired
            expect(() => closed.assertCurrent()).toThrow("callback")
            expect(() => Native.assertInstalled(closed)).toThrow("callback")
            expect(observed).toBe(true)
          } finally {
            intercepted.mockRestore()
          }
        })
      })
    } finally {
      await target.close()
    }
    await expect(openOrganizationService({ home })).rejects.toThrow("restoration")
    const cold = await openOrganizationRecovery({ home })
    try {
      await cold.run(async () => {
        const install = await HomeRestoration.begin(f.request)
        expect((await HomeRestoration.inspect(install)).incarnation).toBe(incarnation)
        await HomeRestoration.withTarget(install, (permit) =>
          Native.withInstalled({ ...f.input, permit }, async (installed) => {
            await installed.verify()
            expect(RuntimeContext.isReady()).toBe(false)
            expect(await Storage.queryKeys({ prefix: [], limit: 1 })).toEqual([])
          }),
        )
      })
    } finally {
      await cold.close()
    }
  } finally {
    await fs.rm(f.directory, { recursive: true, force: true })
  }
})

test("a different fixed native segment cannot publish a Home fence or target files", async () => {
  const f = await fixture()
  const home = path.join(f.directory, "target")
  try {
    await using target = await openOrganizationRecovery({ home })
    await target.run(async () => {
      const install = await HomeRestoration.begin(f.request)
      await HomeRestoration.withTarget(install, async (permit) => {
        await expect(
          Native.withInstalled(
            { ...f.input, source: { ...f.input.source, namespaceID: "foreign" }, permit },
            async () => {},
          ),
        ).rejects.toThrow("another namespace")
        expect(await Bun.file(path.join(home, ".synergy", "home-ownership.json")).exists()).toBe(false)
        expect(
          await Bun.file(path.join(home, ".synergy", "config", "synergy.d", ORGANIZATION_CONFIG_FILENAME)).exists(),
        ).toBe(false)
      })
    })
    const wrongHome = path.join(f.directory, "another-domain")
    await using wrong = await openOrganizationRecovery({ home: wrongHome })
    await wrong.run(async () => {
      const install = await HomeRestoration.begin({ ...f.request, owner: "organization-runtime" })
      await HomeRestoration.withTarget(install, async (permit) => {
        await expect(Native.withInstalled({ ...f.input, permit }, async () => {})).rejects.toThrow("native owner")
        expect(await Bun.file(path.join(wrongHome, ".synergy", "home-ownership.json")).exists()).toBe(false)
      })
    })
  } finally {
    await fs.rm(f.directory, { recursive: true, force: true })
  }
})

test("the original install request refuses another valid native facet for the same SQL checkpoint", async () => {
  const f = await fixture()
  const alternative = path.join(f.directory, "alternative-native")
  const raw = Buffer.from('{"organization":{"authentication":{"loginMs":654321}}}')
  try {
    const { rawConfiguration: _, ...original } = await Native.verify(f.input)
    await using conversion = await openOrganizationRecovery({ home: path.join(f.directory, "conversion") })
    const expected = await conversion.run(async () => {
      await Storage.writeBinary(["service-native", "configuration"], raw)
      await Storage.write(
        ["service-native", "manifest"],
        Native.Manifest.parse({
          ...original,
          configuration: {
            present: true,
            settings: parseOrganizationConfiguration(raw, ORGANIZATION_CONFIG_FILENAME),
            raw: { bytes: raw.byteLength, sha256: createHash("sha256").update(raw).digest("hex") },
          },
        }),
      )
      return StorageCheckpoint.exportArchive({
        directory: alternative,
        archiveID: "alternative-native",
        namespaceID: f.input.expected.namespaceID,
        buildVersion: "fixture",
        keys,
        protect: () => true,
      })
    })
    expect(
      (await Native.verify({ ...f.input, directory: alternative, expected })).configuration.settings,
    ).toMatchObject({
      authentication: { loginMs: 654321 },
    })
    const home = path.join(f.directory, "target")
    await using target = await openOrganizationRecovery({ home })
    await target.run(async () => {
      const install = await HomeRestoration.begin(f.request)
      await HomeRestoration.withTarget(install, async (permit) => {
        await expect(
          Native.withInstalled({ ...f.input, directory: alternative, expected, permit }, async () => {}),
        ).rejects.toThrow("facet")
        expect(await Bun.file(path.join(home, ".synergy", "home-ownership.json")).exists()).toBe(false)
      })
    })
  } finally {
    await fs.rm(f.directory, { recursive: true, force: true })
  }
})

test("restricted service native installation adopts the imported frozen operation into a new retained recovery hold", async () => {
  const f = await fixture()
  const home = path.join(f.directory, "target")
  let installationID = ""
  let sourceOperation = ""
  try {
    await using target = await openOrganizationRecovery({ home })
    await target.run(async () => {
      const selected = await HomeRestoration.begin(f.request)
      await HomeRestoration.withTarget(selected, (permit) =>
        Native.withInstalled({ ...f.input, permit }, async (installed) => {
          installationID = HomeRestoration.describe(permit).installationID
          await StorageCheckpoint.restoreArchive({
            directory: path.join(path.dirname(f.input.directory), "records"),
            expected: f.input.source,
            keys,
            restoreID: f.request.restoreID,
            async finalize(tx, archive) {
              Native.assertInstalled(installed)
              await RuntimeMaintenance.adoptRestoration(tx, { permit, request: f.request, archive })
            },
          })
          const reference = await RuntimeMaintenance.restoration(installationID)
          if (!reference) throw new Error("Native recovery reference was not committed")
          sourceOperation = reference.source.maintenanceID
          expect(reference.source.phase).toBe("frozen")
          expect(reference.target.phase).toBe("recovery-held")
          expect(await RuntimeMaintenance.operation(sourceOperation)).toEqual(reference.source)
          expect((await RuntimeMaintenance.status())?.maintenanceID).toBe(installationID)
          await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
          await expect(Storage.write(["ordinary", "unsafe"], { changed: true })).rejects.toThrow("freezes")
          expect(RuntimeContext.isReady()).toBe(false)
          expect("fetch" in target).toBe(false)
          expect("bootstrapToken" in target).toBe(false)
        }),
      )
    })
    await target.close()
    await expect(openOrganizationService({ home })).rejects.toThrow("restoration")
    await using cold = await openOrganizationRecovery({ home })
    await cold.run(async () => {
      expect((await RuntimeMaintenance.status())?.maintenanceID).toBe(installationID)
      expect((await RuntimeMaintenance.operation(sourceOperation))?.phase).toBe("frozen")
      await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
      await expect(Storage.write(["ordinary", "unsafe"], { changed: true })).rejects.toThrow()
      expect(RuntimeContext.isReady()).toBe(false)
      expect("fetch" in cold).toBe(false)
    })
  } finally {
    await fs.rm(f.directory, { recursive: true, force: true })
  }
}, 15_000)
