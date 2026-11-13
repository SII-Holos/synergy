import { expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { OrganizationCloudOptions } from "../src/cloud"
import { OrganizationServiceHome } from "../src/service-home"
import { openOrganizationService, openOrganizationServiceHomeUpgrade } from "../src/service"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { fixture } from "./support/organization"

const oldOrdinaryReader = "native-organization-service-ownership-v1"
async function oldVersionTwoStartup(home: string) {
  // Keep the released selector independent of the new ServiceHome implementation.
  const program = `
    import path from "node:path"
    import { createHash } from "node:crypto"
    import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
    import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
    import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
    import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
    import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
    const home = process.env.SERVICE_READER_TEST_HOME
    const root = path.join(home, ".synergy")
    const context = RuntimeContext.create({home, root, env:process.env}, "server")
    try {
      await context.run(async () => {
        HomeRestoration.register()
        HomeOwnership.select({ owner:"organization", identity:createHash("sha256").update("synergy.organization.service.v1").digest("hex"), readerContract:"native-organization-service-ownership-v1" })
        const writer = await ServerProcessLock.acquire()
        try {
          await HomeRestoration.assertOrdinaryStartup()
          await HomeOwnership.assert({required:true})
          process.stdout.write("sql-opened\\n")
          const store = await TransactionalStore.open({backend:"sqlite", namespace:"organization", filename:path.join(root,"data","organization.sqlite")})
          try {
            const deployment = await store.read(["organization","deployment"])
            const signing = await store.read(["organization","signing-identity"])
            if (deployment.orgID !== signing.orgID || deployment.deploymentIncarnation !== signing.deploymentIncarnation) throw new Error("Foreign original signing")
            process.stdout.write("ready")
          } finally { await store.close() }
        } finally { await writer.release() }
      })
    } finally { context.dispose() }
  `
  const child = Bun.spawn([process.execPath, "-e", program], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, SERVICE_READER_TEST_HOME: home, SYNERGY_HOME: home, SYNERGY_TEST_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exit, stdout, stderr }
}

function executionConfiguration() {
  let effects = 0
  const provider = {
    id: "reader-fence-provider",
    async allocate() {
      effects++
      throw new Error("Reader selection must not allocate")
    },
    async inspect(): Promise<{ state: "absent" }> {
      effects++
      return { state: "absent" }
    },
    async deallocate() {
      effects++
      throw new Error("Reader selection must not deallocate")
    },
  }
  const cloud: OrganizationCloudOptions = {
    environmentProviders: [provider],
    environmentProfiles: { standard: { provider: provider.id, spec: {} } },
  }
  return { cloud, effects: () => effects }
}

test("fresh Environment-capable service fences the released format-two reader before SQL", async () => {
  const configuration = executionConfiguration()
  await using f = await fixture(undefined, { cloud: configuration.cloud })
  const filename = path.join(f.service.home, ".synergy", "home-ownership.json")
  const original = HomeOwnershipFile.FencedInfo.parse(await Bun.file(filename).json())
  expect(original.schemaVersion).toBe(2)
  await f.service.close()
  const previous = await oldVersionTwoStartup(f.service.home)
  expect(previous.exit).not.toBe(0)
  expect(previous.stdout).toBe("")
  expect(previous.stderr).toContain("explicit migration")
  configuration.cloud.environmentProfiles = {}
  configuration.cloud.environmentProviders = []
  await f.restart()
  expect(HomeOwnershipFile.FencedInfo.parse(await Bun.file(filename).json())).toEqual(original)
  await f.service.close()
  const withoutConfiguration = await oldVersionTwoStartup(f.service.home)
  expect(withoutConfiguration.exit).not.toBe(0)
  expect(withoutConfiguration.stdout).toBe("")
  expect(configuration.effects()).toBe(0)
})

test("a service without Environment configuration retains its released reader and migration catalog", async () => {
  await using f = await fixture()
  const home = f.service.home
  const owner = HomeOwnershipFile.FencedInfo.parse(
    await Bun.file(path.join(home, ".synergy", "home-ownership.json")).json(),
  )
  expect(owner.readerContract).toBe(oldOrdinaryReader)
  expect(
    await f.service.maintenance.run(async () =>
      MigrationRegistry.list()
        .get("organization-service-home")
        ?.map((migration) => migration.id),
    ),
  ).toEqual(["20261112-organization-service-home-reader-fence-v2"])
  await f.service.close()
  const previous = await oldVersionTwoStartup(home)
  expect(previous.exit).toBe(0)
  expect(previous.stdout).toBe("sql-opened\nready")
  await f.restart()
  expect(
    HomeOwnershipFile.FencedInfo.parse(await Bun.file(path.join(home, ".synergy", "home-ownership.json")).json()),
  ).toEqual(owner)
})

test("an established Service advances its Environment reader only through its original frozen upgrade owner", async () => {
  await using f = await fixture()
  const configuration = executionConfiguration()
  const home = f.service.home
  const filename = path.join(home, ".synergy", "home-ownership.json")
  const original = HomeOwnershipFile.FencedInfo.parse(await Bun.file(filename).json())
  const deployment = await f.service.deployment()
  await f.service.close()
  await expect(openOrganizationService({ home, cloud: configuration.cloud })).rejects.toThrow("explicit migration")
  expect(HomeOwnershipFile.FencedInfo.parse(await Bun.file(filename).json())).toEqual(original)
  await using upgrade = await openOrganizationServiceHomeUpgrade({ home, cloud: configuration.cloud })
  await upgrade.maintenance.run(async () => {
    const signing = createHash("sha256")
      .update(JSON.stringify(await Storage.read(Keys.signingIdentity())))
      .digest("hex")
    const identity = await NativeNamespaceIdentity.capture()
    const lease = await RuntimeMaintenance.begin({
      purpose: "organization-backup",
      requestID: "advance-environment-reader",
      actor: {
        kind: "system",
        subjectID: "operator",
        displayName: "Host operator",
        clientKind: "system",
        requestID: "advance-environment-reader",
      },
    })
    await expect(upgrade.upgrade({ lease })).rejects.toThrow("frozen")
    expect(HomeOwnershipFile.FencedInfo.parse(await Bun.file(filename).json())).toEqual(original)
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    await upgrade.upgrade({ lease })
    await upgrade.upgrade({ lease })
    expect(HomeOwnershipFile.FencedInfo.parse(await Bun.file(filename).json())).toEqual({
      ...original,
      readerContract: OrganizationServiceHome.environmentReaderContract,
    })
    await expect(NativeNamespaceIdentity.verify(identity)).rejects.toThrow()
    expect(await Storage.read(Keys.deployment())).toEqual(deployment)
    expect(
      createHash("sha256")
        .update(JSON.stringify(await Storage.read(Keys.signingIdentity())))
        .digest("hex"),
    ).toBe(signing)
    await RuntimeMaintenance.release(lease)
  })
  await upgrade.close()
  const previous = await oldVersionTwoStartup(home)
  expect(previous.exit).not.toBe(0)
  expect(previous.stdout).toBe("")
  await f.restart()
  expect(HomeOwnershipFile.FencedInfo.parse(await Bun.file(filename).json())).toEqual({
    ...original,
    readerContract: OrganizationServiceHome.environmentReaderContract,
  })
  expect(await f.service.deployment()).toEqual(deployment)
  expect(configuration.effects()).toBe(0)
})
