import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { storageTestRuntime } from "@ericsanchezok/synergy-harness/test/support/storage-runtime"
import { OrganizationServiceNative as Native } from "../../src/backup/service-native"
import { OrganizationRecoveryArchive as Archive } from "../../src/backup/archive"
import { OrganizationBackupCohort as Cohort } from "../../src/backup/cohort"
import { OrganizationServiceHome } from "../../src/service-home"
import { OrganizationServiceMaintenance } from "../../src/service-maintenance"
import { openOrganizationService, type OrganizationServiceOptions } from "../../src/service"
import { readOrganizationConfiguration } from "../../src/configuration"
import { loadSigningAuthority } from "../../src/signing"
import { OrganizationStoragePath as Keys } from "../../src/storage/path"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"

const keys = {
  async current() {
    return { version: "recovery", key: Buffer.alloc(32, 9) }
  },
  async resolve() {
    return Buffer.alloc(32, 9)
  },
}
const actor = {
  kind: "system" as const,
  subjectID: "operator",
  displayName: "Operator",
  clientKind: "system" as const,
  requestID: "service-native",
}
async function* files(directory: string, relative = ""): AsyncGenerator<Archive.Source> {
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const logical = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      yield* files(directory, logical)
      continue
    }
    const file = Bun.file(path.join(directory, logical))
    const bytes = new Uint8Array(await file.arrayBuffer())
    yield {
      path: logical,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      read() {
        return file.stream()
      },
    }
  }
}
async function fixture(options: Omit<OrganizationServiceOptions, "home"> = {}, register = true) {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "service-native-"))
  const service = await openOrganizationService({ home })
  await service.close()
  const runtime = await storageTestRuntime({ home })
  const root = path.join(home, ".synergy")
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "organization",
    filename: path.join(root, "data", "organization.sqlite"),
  })
  const lock = await runtime.run(async () => {
    RuntimeContext.current().storage = { store, artifactDirectory: path.join(root, "data", "artifacts") }
    OrganizationServiceHome.select()
    OrganizationServiceHome.registerNamespaceIdentity()
    OrganizationServiceMaintenance.register()
    if (register) Native.register(options)
    return ServerProcessLock.acquire()
  })
  let lease: RuntimeMaintenance.Lease | undefined
  return {
    home,
    root,
    run: runtime.run,
    async capture(directory: string, afterEvidence?: () => Promise<void>, signal?: AbortSignal) {
      return runtime.run(async () => {
        lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
        return RuntimeMaintenance.withFrozen(lease, () =>
          SnapshotMaintenance.withCapture(async (capture) => {
            const source = await capture.exportArchive({
              directory: path.join(directory, "records"),
              archiveID: "service-records",
              namespaceID: "service",
              buildVersion: "fixture",
              keys,
              signal,
              protect: () => true,
            })
            const archive = await capture.validateArchive(source)
            await afterEvidence?.()
            const segment = await Native.capture({
              archive,
              lease: lease!,
              directory: path.join(directory, "native"),
              keys,
              signal,
            })
            return { source, segment }
          }),
        )
      })
    },
    async [Symbol.asyncDispose]() {
      if (lease) await runtime.run(() => RuntimeMaintenance.release(lease!))
      await runtime.run(OrganizationServiceMaintenance.stop)
      await store.close()
      await lock.release()
      await runtime.close()
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

test("a native service segment preserves config meaning and its distinct immutable effective startup snapshot", async () => {
  const options = { publicOrigin: "https://service.example", authentication: { loginMs: 12345 } }
  await using source = await fixture(options)
  const configuration = path.join(source.root, "config", "synergy.d", "150-organization.jsonc")
  await fs.mkdir(path.dirname(configuration), { recursive: true })
  await Bun.write(
    configuration,
    '{ // original disk settings\n "organization": { "authentication": { "loginMs": 54321 } } }',
  )
  options.authentication.loginMs = 99999
  const directory = path.join(source.home, "capture")
  const captured = await source.capture(directory)
  const encrypted = path.join(source.home, "encrypted")
  const opened = path.join(source.home, "opened")
  await Archive.seal({
    directory: encrypted,
    archiveID: "service-native",
    buildVersion: "fixture",
    keys,
    files: files(directory),
  })
  await Archive.open({ directory: encrypted, outputDirectory: opened, keys })
  await fs.rm(directory, { recursive: true })
  const verified = await Native.verify({
    directory: path.join(opened, "native"),
    expected: captured.segment.namespace,
    source: captured.source.namespace,
    keys,
  })
  expect(verified.startup.settings.authentication.loginMs).toBe(12345)
  expect(verified.configuration.settings.authentication?.loginMs).toBe(54321)
  expect(verified.configuration.present).toBe(true)
  expect(Buffer.from(verified.rawConfiguration!).toString()).toBe(await Bun.file(configuration).text())
  expect(verified.owner.schemaVersion).toBe(2)
  await expect(
    Native.verify({
      directory: path.join(opened, "native"),
      expected: captured.segment.namespace,
      source: { ...captured.source.namespace, namespaceID: "foreign" },
      keys,
    }),
  ).rejects.toThrow("namespace")
  const targetHome = path.join(source.home, "independent-target")
  const targetRoot = path.join(targetHome, ".synergy")
  await fs.mkdir(path.join(targetRoot, "config", "synergy.d"), { recursive: true })
  await Bun.write(path.join(targetRoot, "home-ownership.json"), JSON.stringify(verified.owner))
  await Bun.write(path.join(targetRoot, "config", "synergy.d", "150-organization.jsonc"), verified.rawConfiguration!)
  expect(
    await HomeOwnershipFile.open({
      root: targetRoot,
      env: { SYNERGY_TEST_HOME: targetHome },
      selected: verified.owner,
    }).assert({ required: true }),
  ).toEqual(verified.owner)
  expect((await readOrganizationConfiguration(targetHome)).authentication?.loginMs).toBe(54321)
  const target = await storageTestRuntime({ home: targetHome })
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "organization",
    filename: path.join(targetRoot, "data", "organization.sqlite"),
  })
  try {
    await target.run(() =>
      Storage.provide({ store, artifactDirectory: path.join(targetRoot, "data", "artifacts") }, async () => {
        RuntimeMaintenance.registerProtection()
        await StorageCheckpoint.restoreArchive({
          directory: path.join(opened, "records"),
          keys,
          restoreID: "native-cold-read",
          async finalize(tx) {
            await tx.write(["recovery", "gate"], { paused: true })
          },
        })
        const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
        expect((await loadSigningAuthority(deployment)).identity.orgID).toBe(verified.identity.orgID)
        await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
      }),
    )
  } finally {
    await store.close()
    await target.close()
  }
})

test("unregistered startup and unreconstructable external composition cannot yield a complete service native segment", async () => {
  await using unregistered = await fixture({}, false)
  await expect(unregistered.capture(path.join(unregistered.home, "backup"))).rejects.toThrow("startup")
  await using external = await fixture({
    cloud: { workspaceProfiles: { private: { blobStore: "external", settings: {} } } },
  })
  await expect(external.capture(path.join(external.home, "backup"))).rejects.toThrow("composition")
})

test("absent config stays explicit and a missing or foreign Home marker is never synthesized by capture", async () => {
  await using source = await fixture()
  const captured = await source.capture(path.join(source.home, "backup"))
  const value = await Native.verify({
    directory: captured.segment.directory,
    expected: captured.segment.namespace,
    source: captured.source.namespace,
    keys,
  })
  expect(value.configuration.present).toBe(false)
  await using damaged = await fixture()
  await expect(
    damaged.capture(path.join(damaged.home, "missing"), () => fs.rm(path.join(damaged.root, "home-ownership.json"))),
  ).rejects.toThrow("Home")
  expect(await fs.exists(path.join(damaged.root, "home-ownership.json"))).toBe(false)
  expect(await fs.exists(path.join(damaged.home, "missing", "native"))).toBe(false)
})

test("cancellation during the original configuration read closes its descriptor and publishes no native segment", async () => {
  await using source = await fixture()
  const filename = path.join(source.root, "config", "synergy.d", "150-organization.jsonc")
  await fs.mkdir(path.dirname(filename), { recursive: true })
  await Bun.write(filename, "{}")
  const controller = new AbortController()
  const reason = new Error("original native segment cancelled")
  let closed = false
  const open = fs.open.bind(fs)
  const intercept = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args)
    if (String(args[0]) !== filename) return file
    const read = file.read.bind(file)
    const close = file.close.bind(file)
    file.read = (async (...args: Parameters<typeof read>) => {
      const value = await read(...args)
      controller.abort(reason)
      return value
    }) as typeof file.read
    file.close = async () => {
      await close()
      closed = true
    }
    return file
  })
  try {
    await expect(source.capture(path.join(source.home, "cancelled"), undefined, controller.signal)).rejects.toBe(reason)
    expect(closed).toBe(true)
    expect(await fs.exists(path.join(source.home, "cancelled", "native"))).toBe(false)
    expect((await source.run(RuntimeMaintenance.status))?.phase).toBe("frozen")
  } finally {
    intercept.mockRestore()
  }
})

test("the ordinary service cohort includes native config and the actual immutable API startup overrides", async () => {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "service-native-cohort-"))
  const filename = path.join(home, ".synergy", "config", "synergy.d", "150-organization.jsonc")
  await fs.mkdir(path.dirname(filename), { recursive: true })
  await Bun.write(filename, '{"organization":{"authentication":{"loginMs":54321}}}')
  const options = { home, publicOrigin: "https://original.example", authentication: { loginMs: 12345 } }
  const opening = openOrganizationService(options)
  options.authentication.loginMs = 99999
  options.publicOrigin = "https://changed.example"
  const service = await opening
  try {
    const encrypted = path.join(home, "cohort-encrypted")
    const opened = path.join(home, "cohort-opened")
    const report = await Cohort.capture({
      service: Cohort.service(service.maintenance),
      async resolve() {
        return undefined
      },
      directory: encrypted,
      archiveID: "service-native-cohort",
      buildVersion: "fixture",
      keys,
      actor,
    })
    expect(report.namespaceCheckpointsComplete).toBe(true)
    await Archive.open({ directory: encrypted, outputDirectory: opened, keys })
    const base = path.join(opened, "namespaces", "0000000000000000")
    const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
    expect(inventory.native).toBeDefined()
    const verified = await Native.verify({
      directory: path.join(base, "native"),
      expected: inventory.native!,
      source: inventory.namespace,
      keys,
    })
    expect(verified.startup.settings.authentication.loginMs).toBe(12345)
    expect(verified.startup.publicOrigin).toBe("https://original.example")
    expect(verified.configuration.settings.authentication?.loginMs).toBe(54321)
  } finally {
    await service.close()
    await fs.rm(home, { recursive: true, force: true })
  }
})
