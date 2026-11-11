import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { fileLockPath, withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { withTimeout } from "@ericsanchezok/synergy-harness/util/timeout"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { storageTestRuntime } from "@ericsanchezok/synergy-harness/test/support/storage-runtime"
import { prepareHostedHome, prepareMemberHome, readRuntimeHome, type RuntimeIdentity } from "../src/home"
import {
  organizationHomeMigration,
  registerOrganizationHomeMigration,
  upgradeOrganizationHome,
} from "../src/home-migration"

const identities: RuntimeIdentity[] = [
  { orgID: "org", hostID: "hosted" },
  { orgID: "org", accountID: "member", deviceID: "device" },
]
for (const identity of identities) {
  test(`an explicit frozen native ${"accountID" in identity ? "member" : "hosted"} Home migration preserves identity and keys and fences the actual previous Node reader`, async () => {
    const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "hosted-home-upgrade-"))
    const input = { baseDirectory: path.join(directory, "homes"), origin: "https://organization.example" }
    const hosted =
      "accountID" in identity
        ? await prepareMemberHome({ ...input, identity })
        : await prepareHostedHome({ ...input, identity })
    const ownershipFile = path.join(hosted.root, "home-ownership.json")
    const bindingFile = path.join(hosted.root, "organization.json")
    for (const filename of [ownershipFile, bindingFile]) {
      const record = JSON.parse(await fs.readFile(filename, "utf8"))
      delete record.readerContract
      await fs.writeFile(filename, JSON.stringify({ ...record, schemaVersion: 1 }))
    }
    const credentialFile = path.join(hosted.root, "auth", "organization-runtime.json")
    const digest = async () =>
      createHash("sha256")
        .update(await fs.readFile(credentialFile))
        .digest("hex")
    const before = await digest()
    const bundle = await Bun.build({
      entrypoints: [new URL("./support/legacy-home-reader.ts", import.meta.url).pathname],
      target: "node",
    })
    if (!bundle.success) throw new Error("Legacy reader did not build")
    const legacyEntry = path.join(directory, "reader.mjs")
    await fs.writeFile(legacyEntry, await bundle.outputs[0].text())
    const legacy = async () => {
      const child = Bun.spawn(["node", legacyEntry, hosted.home, JSON.stringify(identity)], {
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      })
      const [code, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, stdout }
    }
    const runtime = await storageTestRuntime({ home: hosted.home })
    const store = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(hosted.root, "authority.sqlite"),
      namespace: "hosted",
    })
    try {
      expect(await legacy()).toEqual({ code: 0, stdout: "ready" })
      await expect(readRuntimeHome(hosted.home, identity)).rejects.toThrow("migration")
      await runtime.run(() =>
        Storage.provide({ store, artifactDirectory: path.join(hosted.root, "data") }, async () => {
          RuntimeMaintenance.configure({ required: ["fixture-writer"] })
          RuntimeMaintenance.register("fixture-writer", {
            version: 1,
            async suspend() {},
            async drain() {},
            async inspect() {
              return []
            },
            async release() {},
          })
          registerOrganizationHomeMigration(identity)
          await expect(organizationHomeMigration.up(() => {})).rejects.toThrow("explicit frozen")
          const requestID = "upgrade-hosted"
          const lease = await RuntimeMaintenance.begin({
            purpose: "organization-backup",
            requestID,
            actor: {
              kind: "system",
              subjectID: "operator",
              displayName: "Host operator",
              clientKind: "system",
              requestID,
            },
          })
          await expect(upgradeOrganizationHome({ home: hosted.home, identity, lease })).rejects.toThrow("frozen")
          expect(JSON.parse(await fs.readFile(ownershipFile, "utf8")).schemaVersion).toBe(1)
          await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
          await upgradeOrganizationHome({ home: hosted.home, identity, lease })
          await upgradeOrganizationHome({ home: hosted.home, identity, lease })
          expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
          expect(await readRuntimeHome(hosted.home, identity)).toEqual(hosted)
          await expect(upgradeOrganizationHome({ home: hosted.home, identity, lease: { ...lease } })).rejects.toThrow()
          await expect(
            upgradeOrganizationHome({
              home: hosted.home,
              identity:
                "accountID" in identity ? { ...identity, deviceID: "foreign" } : { ...identity, hostID: "foreign" },
              lease,
            }),
          ).rejects.toThrow()
          await expect(
            upgradeOrganizationHome({ home: path.join(directory, "foreign"), identity, lease }),
          ).rejects.toThrow("another native Home")
        }),
      )
      expect(await digest()).toBe(before)
      expect((await legacy()).code).not.toBe(0)
      expect(JSON.parse(await fs.readFile(ownershipFile, "utf8"))).toMatchObject({
        schemaVersion: 2,
        owner: "organization-runtime",
      })
      expect(JSON.parse(await fs.readFile(bindingFile, "utf8"))).toMatchObject({ schemaVersion: 2, identity })
    } finally {
      await store.close()
      await runtime.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test(`an interrupted ${"accountID" in identity ? "member" : "hosted"} Home upgrade retains its version fence and resumes the same files without rotating credentials`, async () => {
    const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "hosted-interrupted-upgrade-"))
    const input = { baseDirectory: path.join(directory, "homes"), origin: "https://organization.example" }
    const hosted =
      "accountID" in identity
        ? await prepareMemberHome({ ...input, identity })
        : await prepareHostedHome({ ...input, identity })
    const ownershipFile = path.join(hosted.root, "home-ownership.json")
    const bindingFile = path.join(hosted.root, "organization.json")
    for (const filename of [ownershipFile, bindingFile]) {
      const record = JSON.parse(await fs.readFile(filename, "utf8"))
      delete record.readerContract
      await fs.writeFile(filename, JSON.stringify({ ...record, schemaVersion: 1 }))
    }
    const runtime = await storageTestRuntime({ home: hosted.home })
    const store = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(hosted.root, "authority.sqlite"),
      namespace: "hosted",
    })
    try {
      await runtime.run(() =>
        Storage.provide({ store, artifactDirectory: path.join(hosted.root, "data") }, async () => {
          RuntimeMaintenance.configure({ required: ["fixture-writer"] })
          RuntimeMaintenance.register("fixture-writer", {
            version: 1,
            async suspend() {},
            async drain() {},
            async inspect() {
              return []
            },
            async release() {},
          })
          registerOrganizationHomeMigration(identity)
          const requestID = "upgrade-interrupted"
          const lease = await RuntimeMaintenance.begin({
            purpose: "organization-backup",
            requestID,
            actor: {
              kind: "system",
              subjectID: "operator",
              displayName: "Host operator",
              clientKind: "system",
              requestID,
            },
          })
          await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
          const write = AtomicFile.writeJsonAtomic
          const failure = spyOn(AtomicFile, "writeJsonAtomic").mockImplementation(
            async (filename, content, options) => {
              if (filename === bindingFile) throw new Error("Fixture binding write failed after ownership fence")
              return write(filename, content, options)
            },
          )
          try {
            await expect(upgradeOrganizationHome({ home: hosted.home, identity, lease })).rejects.toThrow(
              "binding write failed",
            )
          } finally {
            failure.mockRestore()
          }
          expect(JSON.parse(await fs.readFile(ownershipFile, "utf8")).schemaVersion).toBe(2)
          expect(JSON.parse(await fs.readFile(bindingFile, "utf8")).schemaVersion).toBe(1)
          await expect(readRuntimeHome(hosted.home, identity)).rejects.toThrow("unsupported")
          await upgradeOrganizationHome({ home: hosted.home, identity, lease })
          expect((await readRuntimeHome(hosted.home, identity)).publicKey).toBe(hosted.publicKey)
          const ownership = JSON.parse(await fs.readFile(ownershipFile, "utf8"))
          const unknown = JSON.stringify({ ...ownership, readerContract: "future-maintenance" })
          await fs.writeFile(ownershipFile, unknown)
          await expect(upgradeOrganizationHome({ home: hosted.home, identity, lease })).rejects.toThrow("unsupported")
          expect(await fs.readFile(ownershipFile, "utf8")).toBe(unknown)
          await expect(readRuntimeHome(hosted.home, identity)).rejects.toThrow("migration")
        }),
      )
    } finally {
      await store.close()
      await runtime.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test(`cancelling a ${"accountID" in identity ? "member" : "hosted"} upgrade leaves a retained Home ownership lock untouched and releases the native frozen lifetime`, async () => {
    const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "hosted-cancelled-upgrade-"))
    const input = { baseDirectory: path.join(directory, "homes"), origin: "https://organization.example" }
    const hosted =
      "accountID" in identity
        ? await prepareMemberHome({ ...input, identity })
        : await prepareHostedHome({ ...input, identity })
    const ownershipFile = path.join(hosted.root, "home-ownership.json")
    const bindingFile = path.join(hosted.root, "organization.json")
    for (const filename of [ownershipFile, bindingFile]) {
      const record = JSON.parse(await fs.readFile(filename, "utf8"))
      delete record.readerContract
      await fs.writeFile(filename, JSON.stringify({ ...record, schemaVersion: 1 }))
    }
    const runtime = await storageTestRuntime({ home: hosted.home })
    const store = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(hosted.root, "authority.sqlite"),
      namespace: "hosted",
    })
    try {
      await runtime.run(() =>
        Storage.provide({ store, artifactDirectory: path.join(hosted.root, "data") }, async () => {
          RuntimeMaintenance.configure({ required: ["fixture-writer"] })
          RuntimeMaintenance.register("fixture-writer", {
            version: 1,
            async suspend() {},
            async drain() {},
            async inspect() {
              return []
            },
            async release() {},
          })
          registerOrganizationHomeMigration(identity)
          const requestID = "upgrade-cancelled"
          const lease = await RuntimeMaintenance.begin({
            purpose: "organization-backup",
            requestID,
            actor: {
              kind: "system",
              subjectID: "operator",
              displayName: "Host operator",
              clientKind: "system",
              requestID,
            },
          })
          await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
          const locks = path.join(hosted.root, "state", ".locks")
          const filename = fileLockPath(locks, "home-ownership")
          const held = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const queued = Promise.withResolvers<void>()
          const holding = withFileLock({ directory: locks, key: "home-ownership" }, async () => {
            held.resolve()
            await release.promise
          })
          await held.promise
          const open = fs.open
          const observe = spyOn(fs, "open").mockImplementation(async (...args) => {
            try {
              return await open(...args)
            } catch (error) {
              if (args[0] === filename && (error as NodeJS.ErrnoException).code === "EEXIST") queued.resolve()
              throw error
            }
          })
          const controller = new AbortController()
          const reason = new Error("Stop the queued hosted upgrade")
          const upgrading = upgradeOrganizationHome({
            home: hosted.home,
            identity,
            lease,
            signal: controller.signal,
          }).then(
            () => undefined,
            (error: unknown) => error,
          )
          try {
            await withTimeout(queued.promise, 5000)
            controller.abort(reason)
            expect(await withTimeout(upgrading, 1000)).toBe(reason)
            expect(JSON.parse(await fs.readFile(ownershipFile, "utf8")).schemaVersion).toBe(1)
            expect(JSON.parse(await fs.readFile(bindingFile, "utf8")).schemaVersion).toBe(1)
            await fs.access(filename)
            expect(await RuntimeMaintenance.withFrozen(lease, async () => "still frozen")).toBe("still frozen")
          } finally {
            observe.mockRestore()
            release.resolve()
            await holding
            await upgrading
          }
        }),
      )
    } finally {
      await store.close()
      await runtime.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
}
