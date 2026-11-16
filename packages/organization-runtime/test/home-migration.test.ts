import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { fileLockPath, withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { withTimeout } from "@ericsanchezok/synergy-harness/util/timeout"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { storageTestRuntime } from "@ericsanchezok/synergy-harness/test/support/storage-runtime"
import { registerOrganizationHomeMigration } from "../src/home-migration"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { prepareHostedHome, prepareMemberHome, readRuntimeHome, type RuntimeIdentity } from "../src/home"
import { organizationHomeMigration, upgradeOrganizationHome } from "../src/home-migration"

import { selectedHomeUpgradeOwner } from "./support/home-upgrade"
import { NativeHomeReaderContract } from "../src/home-schema"

const previousReader = "native-organization-ownership-v3"
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
      await fs.writeFile(filename, JSON.stringify({ ...record, schemaVersion: 2, readerContract: previousReader }))
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
      const child = Bun.spawn(["node", legacyEntry, hosted.home, JSON.stringify(identity), "before-initial"], {
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
    const owner = await selectedHomeUpgradeOwner(hosted)
    try {
      expect(await legacy()).toEqual({ code: 0, stdout: "ready" })
      await expect(readRuntimeHome(hosted.home, identity)).rejects.toThrow("migration")
      await owner.run(async () => {
        await expect(organizationHomeMigration.up(() => {})).rejects.toThrow("explicit frozen")
        const requestID = "upgrade-hosted"
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-home-upgrade",
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
        expect(JSON.parse(await fs.readFile(ownershipFile, "utf8")).readerContract).toBe(previousReader)
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
      })
      expect(await digest()).toBe(before)
      expect((await legacy()).code).not.toBe(0)
      expect(JSON.parse(await fs.readFile(ownershipFile, "utf8"))).toMatchObject({
        schemaVersion: 2,
        owner: "organization-runtime",
      })
      expect(JSON.parse(await fs.readFile(bindingFile, "utf8"))).toMatchObject({ schemaVersion: 2, identity })
    } finally {
      await owner.close()
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
      await fs.writeFile(filename, JSON.stringify({ ...record, schemaVersion: 2, readerContract: previousReader }))
    }
    const owner = await selectedHomeUpgradeOwner(hosted)
    try {
      await owner.run(async () => {
        const requestID = "upgrade-interrupted"
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-home-upgrade",
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
        const failure = spyOn(AtomicFile, "writeJsonAtomic").mockImplementation(async (filename, content, options) => {
          if (filename === bindingFile) throw new Error("Fixture binding write failed after ownership fence")
          return write(filename, content, options)
        })
        try {
          await expect(upgradeOrganizationHome({ home: hosted.home, identity, lease })).rejects.toThrow(
            "binding write failed",
          )
        } finally {
          failure.mockRestore()
        }
        expect(JSON.parse(await fs.readFile(ownershipFile, "utf8")).readerContract).toBe(NativeHomeReaderContract)
        expect(JSON.parse(await fs.readFile(bindingFile, "utf8")).readerContract).toBe(previousReader)
        await expect(readRuntimeHome(hosted.home, identity)).rejects.toThrow("unsupported")
        await upgradeOrganizationHome({ home: hosted.home, identity, lease })
        expect((await readRuntimeHome(hosted.home, identity)).publicKey).toBe(hosted.publicKey)
        const ownership = JSON.parse(await fs.readFile(ownershipFile, "utf8"))
        const unknown = JSON.stringify({ ...ownership, readerContract: "future-maintenance" })
        await fs.writeFile(ownershipFile, unknown)
        await expect(upgradeOrganizationHome({ home: hosted.home, identity, lease })).rejects.toThrow(
          "original or target marker",
        )
        expect(await fs.readFile(ownershipFile, "utf8")).toBe(unknown)
        await expect(readRuntimeHome(hosted.home, identity)).rejects.toThrow("migration")
      })
    } finally {
      await owner.close()
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
      await fs.writeFile(filename, JSON.stringify({ ...record, schemaVersion: 2, readerContract: previousReader }))
    }
    const owner = await selectedHomeUpgradeOwner(hosted)
    try {
      await owner.run(async () => {
        const requestID = "upgrade-cancelled"
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-home-upgrade",
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
          expect(JSON.parse(await fs.readFile(ownershipFile, "utf8")).readerContract).toBe(previousReader)
          expect(JSON.parse(await fs.readFile(bindingFile, "utf8")).readerContract).toBe(previousReader)
          await fs.access(filename)
          expect(await RuntimeMaintenance.withFrozen(lease, async () => "still frozen")).toBe("still frozen")
        } finally {
          observe.mockRestore()
          release.resolve()
          await holding
          await upgrading
        }
      })
    } finally {
      await owner.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
}

for (const identity of identities)
  test(`an unfenced legacy ${"accountID" in identity ? "member" : "hosted"} Home cannot turn a targetless backup hold into reader five`, async () => {
    const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "unsupported-legacy-home-"))
    const input = { baseDirectory: directory, origin: "https://organization.example" }
    const home =
      "accountID" in identity
        ? await prepareMemberHome({ ...input, identity })
        : await prepareHostedHome({ ...input, identity })
    const files = ["home-ownership.json", "organization.json"].map((name) => path.join(home.root, name))
    for (const file of files) {
      const value = JSON.parse(await fs.readFile(file, "utf8"))
      delete value.readerContract
      await fs.writeFile(file, JSON.stringify({ ...value, schemaVersion: 1 }))
    }
    const credentials = path.join(home.root, "auth", "organization-runtime.json")
    const original = await Promise.all([...files, credentials].map((file) => fs.readFile(file)))
    const runtime = await storageTestRuntime({ home: home.home })
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "legacy-home-hold",
      filename: path.join(home.root, "authority.sqlite"),
    })
    try {
      await runtime.run(async () => {
        RuntimeContext.current().storage = { store, artifactDirectory: path.join(home.root, "data") }
        RuntimeMaintenance.configure({ required: ["legacy-native-writer"] })
        RuntimeMaintenance.register("legacy-native-writer", {
          version: 1,
          async suspend(current) {
            await RuntimeMaintenance.assertDraining(current.lease)
          },
          async drain(current) {
            await RuntimeMaintenance.assertDraining(current.lease)
          },
          async inspect() {
            return []
          },
          async release(current) {
            await RuntimeMaintenance.assertReleasing(current.lease)
          },
        })
        registerOrganizationHomeMigration(identity)
        RuntimeContext.sealComposition()
        await Storage.write(["legacy-home-retained"], { original: true })
        const requestID = "legacy-targetless-hold"
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-backup",
          requestID,
          actor: { kind: "system", subjectID: "operator", displayName: "Operator", clientKind: "system", requestID },
        })
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
        const retained = await RuntimeMaintenance.assertHeld(lease)
        expect(retained.version).toBe(1)
        await expect(upgradeOrganizationHome({ home: home.home, identity, lease })).rejects.toThrow("unsupported")
        expect(await RuntimeMaintenance.assertHeld(lease)).toEqual(retained)
        expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
        expect(await Promise.all([...files, credentials].map((file) => fs.readFile(file)))).toEqual(original)
        expect(await Storage.read(["legacy-home-retained"])).toEqual({ original: true })
        await expect(readRuntimeHome(home.home, identity)).rejects.toThrow("migration")
        await RuntimeMaintenance.release(lease)
      })
    } finally {
      await store.close()
      await runtime.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
