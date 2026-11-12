import { expect, test } from "bun:test"
import { z } from "zod"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { storageTestRuntime } from "@ericsanchezok/synergy-harness/test/support/storage-runtime"
import { OrganizationServiceHome } from "../src/service-home"
import { OrganizationServiceMaintenance } from "../src/service-maintenance"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { fixture } from "./support/organization"
import { openOrganizationService, openOrganizationServiceHomeUpgrade } from "../src/service"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { registerOrganizationMigrations } from "../src/migration"

const request = {
  purpose: "organization-backup" as const,
  requestID: "upgrade-service-home",
  actor: {
    kind: "system" as const,
    subjectID: "operator",
    displayName: "Host operator",
    clientKind: "system" as const,
    requestID: "upgrade-service-home",
  },
}
async function legacy() {
  const instance = await fixture()
  const deployment = await instance.service.deployment()
  await instance.service.close()
  const filename = path.join(instance.service.home, ".synergy", "home-ownership.json")
  const ownership = HomeOwnership.Info.parse(JSON.parse(await fs.readFile(filename, "utf8")))
  await fs.writeFile(
    filename,
    JSON.stringify({ schemaVersion: 1, owner: ownership.owner, identity: ownership.identity }),
  )
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "organization",
    filename: path.join(instance.service.home, ".synergy", "data", "organization.sqlite"),
  })
  try {
    await store.remove(["meta", "migration", "log-organization-service-home"])
  } finally {
    await store.close()
  }
  return Object.assign(instance, { deployment })
}
async function native(home: string) {
  const runtime = await storageTestRuntime({ home })
  const root = path.join(home, ".synergy")
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "organization",
    filename: path.join(root, "data", "organization.sqlite"),
  })
  const ownership = await runtime.run(async () => {
    RuntimeContext.current().storage = { store, artifactDirectory: path.join(root, "data", "artifacts") }
    const ownership = await ServerProcessLock.acquire()
    await OrganizationServiceHome.selectForUpgrade()
    OrganizationServiceMaintenance.register()
    registerOrganizationMigrations()
    return ownership
  })
  return {
    run: runtime.run,
    async [Symbol.asyncDispose]() {
      await runtime.run(OrganizationServiceMaintenance.stop)
      await runtime.close()
      await store.close()
      await ownership.release()
    },
  }
}
async function previousReader(home: string) {
  // Retain the released version-one startup format independently of the current reader's union.
  const program = `
    import { z } from "zod"
    import fs from "node:fs/promises"
    import path from "node:path"
    import { createHash } from "node:crypto"
    import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
    const home = process.env.SERVICE_READER_TEST_HOME
    const root = path.join(home, ".synergy")
    const owner = z.strictObject({ schemaVersion: z.literal(1), owner: z.string(), identity: z.string() }).parse(JSON.parse(await fs.readFile(path.join(root, "home-ownership.json"), "utf8")))
    if (owner.owner !== "organization" || owner.identity !== createHash("sha256").update("synergy.organization.service.v1").digest("hex")) throw new Error("Foreign service Home")
    const store = await TransactionalStore.open({ backend: "sqlite", namespace: "organization", filename: path.join(root, "data", "organization.sqlite") })
    try {
      const deployment = await store.read(["organization", "deployment"])
      const signing = await store.read(["organization", "signing-identity"])
      if (deployment.orgID !== signing.orgID || deployment.deploymentIncarnation !== signing.deploymentIncarnation) throw new Error("Foreign service signing")
      process.stdout.write("ready")
    } finally { await store.close() }
  `
  const child = Bun.spawn([process.execPath, "-e", program], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, SERVICE_READER_TEST_HOME: home },
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

test("explicit frozen service Home upgrade preserves deployment and signing and rejects the released version-one reader", async () => {
  await using f = await legacy()
  const deployment = f.deployment
  await f.service.close()
  expect(await previousReader(f.service.home)).toMatchObject({ exit: 0, stdout: "ready" })
  await using owner = await native(f.service.home)
  await owner.run(async () => {
    const signingBefore = createHash("sha256")
      .update(JSON.stringify(await Storage.read(Keys.signingIdentity())))
      .digest("hex")
    const lease = await RuntimeMaintenance.begin(request)
    await expect(OrganizationServiceHome.upgrade({ home: f.service.home, lease })).rejects.toThrow("frozen")
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    await OrganizationServiceHome.upgrade({ home: f.service.home, lease })
    await OrganizationServiceHome.upgrade({ home: f.service.home, lease })
    expect(await Storage.read(Keys.deployment())).toEqual(deployment)
    expect(
      createHash("sha256")
        .update(JSON.stringify(await Storage.read(Keys.signingIdentity())))
        .digest("hex"),
    ).toBe(signingBefore)
    await expect(OrganizationServiceHome.upgrade({ home: f.service.home, lease: { ...lease } })).rejects.toThrow()
    await expect(
      OrganizationServiceHome.upgrade({ home: path.join(f.service.home, "foreign"), lease }),
    ).rejects.toThrow("another")
    expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
    await RuntimeMaintenance.release(lease)
  })
  const ownership = JSON.parse(await fs.readFile(path.join(f.service.home, ".synergy", "home-ownership.json"), "utf8"))
  expect(ownership).toMatchObject({
    schemaVersion: 2,
    owner: "organization",
    readerContract: OrganizationServiceHome.readerContract,
  })
  const old = await previousReader(f.service.home)
  expect(old.exit).not.toBe(0)
  expect(old.stdout).toBe("")
  expect(old.stderr).toContain("schemaVersion")
})

test("fresh service ownership selects version two without adopting foreign or unknown retained owners", async () => {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "fresh-service-reader-"))
  const runtime = await storageTestRuntime({ home: directory })
  try {
    await runtime.run(async () => {
      OrganizationServiceHome.select()
      await HomeOwnership.persist()
      expect(await HomeOwnership.assert({ required: true })).toMatchObject({
        schemaVersion: 2,
        owner: "organization",
        readerContract: OrganizationServiceHome.readerContract,
      })
    })
    expect((await previousReader(directory)).exit).not.toBe(0)
  } finally {
    await runtime.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("service Home upgrade refuses unknown and foreign formats without rewriting them", async () => {
  await using f = await legacy()
  await f.service.close()
  const filename = path.join(f.service.home, ".synergy", "home-ownership.json")
  const original = JSON.parse(await fs.readFile(filename, "utf8"))
  await using owner = await native(f.service.home)
  await owner.run(async () => {
    const lease = await RuntimeMaintenance.begin(request)
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    for (const record of [
      { ...original, schemaVersion: 2, readerContract: "future-service-reader" },
      { ...original, owner: "foreign-service" },
    ]) {
      const bytes = JSON.stringify(record)
      await fs.writeFile(filename, bytes)
      await expect(OrganizationServiceHome.upgrade({ home: f.service.home, lease })).rejects.toThrow()
      expect(await fs.readFile(filename, "utf8")).toBe(bytes)
    }
    await fs.writeFile(filename, JSON.stringify(original))
    await OrganizationServiceHome.upgrade({ home: f.service.home, lease })
    await RuntimeMaintenance.release(lease)
  })
})

test("cancelling service Home upgrade exits its retained ownership file lock without releasing that owner", async () => {
  const { withFileLock, fileLockPath } = await import("@ericsanchezok/synergy-util/fs-lock")
  await using f = await legacy()
  await f.service.close()
  const root = path.join(f.service.home, ".synergy")
  await using owner = await native(f.service.home)
  await owner.run(async () => {
    const lease = await RuntimeMaintenance.begin(request)
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const retained = withFileLock(
      { directory: path.join(root, "state", ".locks"), key: "home-ownership" },
      async () => {
        entered.resolve()
        await release.promise
      },
    )
    await entered.promise
    const abort = new AbortController()
    const reason = new Error("cancel service format upgrade")
    const upgrade = OrganizationServiceHome.upgrade({ home: f.service.home, lease, signal: abort.signal })
    void upgrade.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outer = fileLockPath(path.join(root, "state", ".locks"), "organization-service-home-format")
      for (let turn = 0; !(await fs.exists(outer)); turn++) {
        if (turn > 100) throw new Error("Service format lock was not entered")
        await Bun.sleep(10)
      }
      abort.abort(reason)
      await expect(
        Promise.race([
          upgrade,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("blocked behind retained Home owner")), 1000)
          }),
        ]),
      ).rejects.toBe(reason)
      expect(JSON.parse(await fs.readFile(path.join(root, "home-ownership.json"), "utf8")).schemaVersion).toBe(1)
      expect(await fs.exists(fileLockPath(path.join(root, "state", ".locks"), "home-ownership"))).toBe(true)
      await RuntimeMaintenance.release(lease)
    } finally {
      if (timer) clearTimeout(timer)
      release.resolve()
      await retained
      await Promise.allSettled([upgrade])
    }
  })
})

test("an ownership fence committed before a failed migration receipt is recovered forward without changing signing", async () => {
  const { spyOn } = await import("bun:test")
  await using f = await legacy()
  await f.service.close()
  await using owner = await native(f.service.home)
  await owner.run(async () => {
    const lease = await RuntimeMaintenance.begin(request)
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    const write = Storage.write
    const failing = spyOn(Storage, "write").mockImplementation(async (...args) => {
      if (args[0].join("/") === "meta/migration/log-organization-service-home")
        throw new Error("service Home migration receipt failed")
      return write(...args)
    })
    try {
      await expect(OrganizationServiceHome.upgrade({ home: f.service.home, lease })).rejects.toThrow("receipt failed")
    } finally {
      failing.mockRestore()
    }
    expect(
      JSON.parse(await fs.readFile(path.join(f.service.home, ".synergy", "home-ownership.json"), "utf8")).schemaVersion,
    ).toBe(2)
    expect((await previousReader(f.service.home)).exit).not.toBe(0)
    await OrganizationServiceHome.upgrade({ home: f.service.home, lease })
    expect(await Storage.read(["meta", "migration", "log-organization-service-home"])).toHaveProperty(
      "20261112-organization-service-home-reader-fence-v2",
    )
    await RuntimeMaintenance.release(lease)
  })
})

test("ordinary organization startup publishes the current service reader fence", async () => {
  await using f = await fixture()
  expect(
    JSON.parse(await fs.readFile(path.join(f.service.home, ".synergy", "home-ownership.json"), "utf8")),
  ).toMatchObject({ schemaVersion: 2, readerContract: OrganizationServiceHome.readerContract })
})

test("legacy service startup stays closed until the restricted native upgrade publishes its version-two fence", async () => {
  await using f = await legacy()
  await expect(openOrganizationService({ home: f.service.home })).rejects.toThrow("explicit migration")
  await using upgrade = await openOrganizationServiceHomeUpgrade({ home: f.service.home })
  expect(Object.keys(upgrade)).not.toContain("fetch")
  expect(Object.keys(upgrade)).not.toContain("websocket")
  expect(Object.keys(upgrade)).not.toContain("bootstrapToken")
  const lease = await upgrade.maintenance.run(async () => {
    const lease = await RuntimeMaintenance.begin(request)
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    return lease
  })
  await upgrade.upgrade({ lease })
  await upgrade.maintenance.run(() => RuntimeMaintenance.release(lease))
  await upgrade.close()
  await using serving = await openOrganizationService({ home: f.service.home })
  expect(await serving.deployment()).toEqual(f.deployment)
  expect(await serving.capabilities()).toEqual({ protocolVersion: 1, executesAgents: false })
  await serving.maintenance.run(async () => {
    const identity = await NativeNamespaceIdentity.capture()
    expect(NativeNamespaceIdentity.inspect(identity)).toEqual({
      owner: "organization",
      identity: {
        kind: "service",
        orgID: f.deployment.orgID,
        deploymentIncarnation: f.deployment.deploymentIncarnation,
      },
    })
    await NativeNamespaceIdentity.verify(identity)
  })
})

test("a copied deployment record cannot certify an Agent Home as an organization service namespace", async () => {
  const { testRuntime } = await import("@ericsanchezok/synergy-harness/test/support/runtime")
  const { OrganizationBackupCohort: Cohort } = await import("../src/backup/cohort")
  const { randomBytes } = await import("node:crypto")
  await using f = await fixture()
  await using agent = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["sessions", "loop-jobs", "environments"] })
    },
  })
  const deployment = await f.service.deployment()
  await agent.run(async () => {
    await Storage.write(Keys.deployment(), deployment)
    await Storage.write(["not-service-history"], { copied: true })
  })
  const material = randomBytes(32)
  const directory = path.join(f.service.home, "false-service-checkpoint")
  const keys = {
    async current() {
      return { version: "recovery", key: material }
    },
    async resolve() {
      return material
    },
  }
  try {
    await expect(
      Cohort.capture({
        service: Cohort.service(agent),
        async resolve() {
          return undefined
        },
        directory,
        archiveID: "false-service",
        buildVersion: "fixture",
        keys,
        actor: request.actor,
      }),
    ).rejects.toThrow()
    expect(await fs.exists(directory)).toBe(false)
    await agent.run(async () => {
      expect(await RuntimeMaintenance.status()).toBeUndefined()
    })
  } finally {
    material.fill(0)
  }
})

test("a lost established Home marker blocks startup before reconciling pending canonical migrations", async () => {
  await using f = await fixture()
  await f.service.close()
  const filename = path.join(f.service.home, ".synergy", "data", "organization.sqlite")
  const logKey = ["meta", "migration", "log-organization"]
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: "organization", filename })
  let pending: Record<string, number>
  try {
    pending = { ...(await store.read<Record<string, number>>(logKey)) }
    expect(pending).toHaveProperty("20261108-organization-home-ownership")
    delete pending["20261109-organization-signing-identity"]
    await store.write(logKey, pending)
  } finally {
    await store.close()
  }
  await fs.rm(path.join(f.service.home, ".synergy", "home-ownership.json"))
  await expect(openOrganizationService({ home: f.service.home })).rejects.toThrow()
  const after = await TransactionalStore.open({ backend: "sqlite", namespace: "organization", filename })
  try {
    expect(await after.read(logKey)).toEqual(pending)
  } finally {
    await after.close()
  }
})

test("a fresh interruption before durable owner publication never initializes signing and can reopen", async () => {
  const { AtomicFile } = await import("@ericsanchezok/synergy-util/atomic-file")
  const { spyOn } = await import("bun:test")
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "service-before-owner-"))
  const filename = path.join(home, ".synergy", "home-ownership.json")
  const write = AtomicFile.writeJsonAtomic
  const failure = spyOn(AtomicFile, "writeJsonAtomic").mockImplementation(async (...args) => {
    if (args[0] === filename) throw new Error("interrupted before owner publication")
    return write(...args)
  })
  try {
    try {
      await expect(openOrganizationService({ home })).rejects.toThrow("before owner publication")
    } finally {
      failure.mockRestore()
    }
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "organization",
      filename: path.join(home, ".synergy", "data", "organization.sqlite"),
    })
    let deployment: z.infer<typeof OrganizationProtocol.Deployment>
    try {
      expect((await store.readMany([Keys.signingIdentity()]))[0]).toBeUndefined()
      deployment = OrganizationProtocol.Deployment.parse(await store.read(Keys.deployment()))
    } finally {
      await store.close()
    }
    expect(await fs.exists(filename)).toBe(false)
    await using reopened = await openOrganizationService({ home })
    expect(await reopened.deployment()).toEqual(deployment)
  } finally {
    failure.mockRestore()
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("a fresh signing commit without its receipt retains the earlier durable owner and reopens without key rotation", async () => {
  const { spyOn } = await import("bun:test")
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "service-after-signing-"))
  const write = Storage.write
  const failure = spyOn(Storage, "write").mockImplementation(async (...args) => {
    const value = args[1]
    if (
      args[0].join("/") === "meta/migration/log-organization" &&
      value &&
      typeof value === "object" &&
      Object.hasOwn(value, "20261109-organization-signing-identity")
    )
      throw new Error("interrupted after signing commit")
    return write(...args)
  })
  try {
    try {
      await expect(openOrganizationService({ home })).rejects.toThrow("after signing commit")
    } finally {
      failure.mockRestore()
    }
    expect(JSON.parse(await fs.readFile(path.join(home, ".synergy", "home-ownership.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      readerContract: OrganizationServiceHome.readerContract,
    })
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "organization",
      filename: path.join(home, ".synergy", "data", "organization.sqlite"),
    })
    let signingHash: string
    try {
      const log = await store.read<Record<string, number>>(["meta", "migration", "log-organization"])
      expect(log).toHaveProperty("20261108-organization-home-ownership")
      expect(log).not.toHaveProperty("20261109-organization-signing-identity")
      signingHash = createHash("sha256")
        .update(JSON.stringify(await store.read(Keys.signingIdentity())))
        .digest("hex")
    } finally {
      await store.close()
    }
    await using reopened = await openOrganizationService({ home })
    await reopened.maintenance.run(async () => {
      expect(
        createHash("sha256")
          .update(JSON.stringify(await Storage.read(Keys.signingIdentity())))
          .digest("hex"),
      ).toBe(signingHash)
    })
  } finally {
    failure.mockRestore()
    await fs.rm(home, { recursive: true, force: true })
  }
})
