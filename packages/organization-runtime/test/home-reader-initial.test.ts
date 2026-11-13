import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { storageTestRuntime } from "@ericsanchezok/synergy-harness/test/support/storage-runtime"
import { prepareHostedHome, prepareMemberHome, readRuntimeHome, type RuntimeIdentity } from "../src/home"
import {
  organizationHomeMigration,
  registerOrganizationHomeMigration,
  upgradeOrganizationHome,
} from "../src/home-migration"
import { NativeHomeReaderContract } from "../src/home-schema"

const previousReader = "native-organization-ownership-v3"
const identities: RuntimeIdentity[] = [
  { orgID: "org", hostID: "hosted" },
  { orgID: "org", accountID: "member", deviceID: "device" },
]

for (const identity of identities)
  test(`the original ${"accountID" in identity ? "member" : "hosted"} Home advances its initial Workspace reader through a lost-ACK native fence without changing identity`, async () => {
    const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "initial-workspace-home-"))
    const input = { baseDirectory: path.join(directory, "homes"), origin: "https://organization.example" }
    const home =
      "accountID" in identity
        ? await prepareMemberHome({ ...input, identity })
        : await prepareHostedHome({ ...input, identity })
    const ownershipFile = path.join(home.root, "home-ownership.json")
    const bindingFile = path.join(home.root, "organization.json")
    const credentialsFile = path.join(home.root, "auth", "organization-runtime.json")
    const credentialHash = () =>
      Bun.file(credentialsFile)
        .bytes()
        .then((bytes) => createHash("sha256").update(bytes).digest("hex"))
    const beforeCredentials = await credentialHash()
    for (const filename of [ownershipFile, bindingFile]) {
      const current = await Bun.file(filename).json()
      await fs.writeFile(filename, JSON.stringify({ ...current, readerContract: previousReader }))
    }
    const previousFiles = await Promise.all([ownershipFile, bindingFile].map((file) => Bun.file(file).text()))
    const originalMarker = await fs.stat(ownershipFile)
    const bundle = await Bun.build({
      entrypoints: [new URL("./support/legacy-home-reader.ts", import.meta.url).pathname],
      target: "node",
    })
    if (!bundle.success) throw new Error("The released reader-three Node entry did not compile")
    const entry = path.join(directory, "reader-three.mjs")
    const previousDatabase = path.join(home.root, "previous-reader.sqlite")
    await Bun.write(entry, await bundle.outputs[0]!.text())
    const previousStartup = async () => {
      const child = Bun.spawn(
        ["node", entry, home.home, JSON.stringify(identity), "before-initial", previousDatabase],
        {
          env: { ...process.env },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        },
      )
      const [code, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, stdout }
    }
    const runtime = await storageTestRuntime({ home: home.home })
    const store = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(home.root, "authority.sqlite"),
      namespace: "initial-workspace-home",
    })
    try {
      expect(await previousStartup()).toEqual({ code: 0, stdout: "ready" })
      expect(await Bun.file(previousDatabase).exists()).toBe(true)
      await fs.rm(previousDatabase)
      await expect(readRuntimeHome(home.home, identity)).rejects.toThrow("migration")
      expect(await Promise.all([ownershipFile, bindingFile].map((file) => Bun.file(file).text()))).toEqual(
        previousFiles,
      )
      await runtime.run(() =>
        Storage.provide({ store, artifactDirectory: path.join(home.root, "data") }, async () => {
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
          using legacyUpgrade = spyOn(organizationHomeMigration, "up")
          registerOrganizationHomeMigration(identity)
          const requestID = "initial-workspace-reader"
          const lease = await RuntimeMaintenance.begin({
            purpose: "organization-backup",
            requestID,
            actor: { kind: "system", subjectID: "operator", displayName: "Operator", clientKind: "system", requestID },
          })
          await expect(upgradeOrganizationHome({ home: home.home, identity, lease })).rejects.toThrow("frozen")
          await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
          const open = fs.open
          let lost = false
          using lostAck = spyOn(fs, "open").mockImplementation(async (...args) => {
            const file = await open(...args)
            if (args[0] === ownershipFile && typeof args[1] === "number" && !lost) {
              const sync = file.sync.bind(file)
              spyOn(file, "sync").mockImplementationOnce(async () => {
                await sync()
                lost = true
                throw new Error("Lost original reader-four marker acknowledgement")
              })
            }
            return file
          })
          await expect(upgradeOrganizationHome({ home: home.home, identity, lease })).rejects.toThrow("Lost original")
          lostAck.mockRestore()
          expect(lost).toBe(true)
          expect((await Bun.file(ownershipFile).json()).readerContract).toBe(NativeHomeReaderContract)
          expect((await Bun.file(bindingFile).json()).readerContract).toBe(previousReader)
          expect((await fs.stat(ownershipFile)).ino).toBe(originalMarker.ino)
          await expect(readRuntimeHome(home.home, identity)).rejects.toThrow("unsupported")
          expect((await previousStartup()).code).not.toBe(0)
          expect(await Bun.file(previousDatabase).exists()).toBe(false)
          await upgradeOrganizationHome({ home: home.home, identity, lease })
          const completed = await Promise.all([ownershipFile, bindingFile].map((file) => Bun.file(file).text()))
          await upgradeOrganizationHome({ home: home.home, identity, lease })
          expect(await Promise.all([ownershipFile, bindingFile].map((file) => Bun.file(file).text()))).toEqual(
            completed,
          )
          expect(await readRuntimeHome(home.home, identity)).toEqual(home)
          expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
          expect(legacyUpgrade).not.toHaveBeenCalled()
          for (const readerContract of [
            "native-organization-ownership-v1",
            "native-organization-ownership-v2",
            "future-reader",
          ]) {
            for (const [index, file] of [ownershipFile, bindingFile].entries())
              await fs.writeFile(file, JSON.stringify({ ...JSON.parse(completed[index]!), readerContract }))
            const unsupported = await Promise.all([ownershipFile, bindingFile].map((file) => Bun.file(file).text()))
            await expect(upgradeOrganizationHome({ home: home.home, identity, lease })).rejects.toThrow("unsupported")
            expect(await Promise.all([ownershipFile, bindingFile].map((file) => Bun.file(file).text()))).toEqual(
              unsupported,
            )
          }
          const restored = HomeOwnershipFile.RestorationInfo.parse({
            ...JSON.parse(completed[0]!),
            schemaVersion: 3,
            readerContract: previousReader,
            installationID: crypto.randomUUID(),
            incarnation: crypto.randomUUID(),
          })
          await fs.writeFile(ownershipFile, JSON.stringify(restored))
          await fs.writeFile(
            bindingFile,
            JSON.stringify({ ...JSON.parse(completed[1]!), readerContract: previousReader }),
          )
          await expect(upgradeOrganizationHome({ home: home.home, identity, lease })).rejects.toThrow("unsupported")
          expect(await Bun.file(ownershipFile).json()).toEqual(restored)
          expect(await credentialHash()).toBe(beforeCredentials)
        }),
      )
    } finally {
      await store.close()
      await runtime.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
