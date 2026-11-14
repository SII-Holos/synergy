import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageEventSinks } from "@ericsanchezok/synergy-harness/storage/event-sinks"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/context"
import { runMigrations } from "@ericsanchezok/synergy-harness/migration"
import { prepareHostedHome, prepareMemberHome, readRuntimeHome } from "../src/home"
import { upgradeOrganizationHome } from "../src/home-migration"
import { selectedHomeUpgradeOwner } from "./support/home-upgrade"

const oldReader = "native-organization-ownership-v4"
const currentReader = "native-organization-ownership-v5"
const Changed = BusEvent.define("test.organization.home.retained", z.object({ value: z.string() }))
const dataKey = ["home-reader-sync-fixture", "retained"]
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")
type Home = Awaited<ReturnType<typeof prepareHostedHome>> | Awaited<ReturnType<typeof prepareMemberHome>>
const pair = (home: Home) => ["home-ownership.json", "organization.json"].map((name) => path.join(home.root, name))
const bytes = (home: Home) => Promise.all(pair(home).map((name) => fs.readFile(name, "utf8")))
const keys = (home: Home) => fs.readFile(path.join(home.root, "auth", "organization-runtime.json")).then(hash)

const actor = (requestID: string) => ({
  kind: "system" as const,
  subjectID: "native-operator",
  displayName: "Native operator",
  clientKind: "system" as const,
  requestID,
})
async function seed() {
  await ScopeContext.provide({
    scope: Scope.home(),
    fn: () =>
      Storage.transaction(async () => {
        await Storage.write(dataKey, { value: "original native bytes" })
        await Bus.publish(Changed, { value: "retained durable fact" })
      }),
  })
  const deliveries = await Storage.query({ kind: "event_delivery" })
  expect(deliveries).toHaveLength(1)
  return deliveries
}

for (const kind of ["member", "hosted"] as const)
  test(`the original ${kind} Home advances reader four to five after cold lost-ACK recovery without consuming retained native deliveries`, async () => {
    const directory = await fs.realpath(
      await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "durable-sync-reader-")),
    )
    try {
      const input = { baseDirectory: directory, origin: "https://organization.example" }
      const home =
        kind === "member"
          ? await prepareMemberHome({ ...input, identity: { orgID: "org", accountID: "member", deviceID: "device" } })
          : await prepareHostedHome({ ...input, identity: { orgID: "org", hostID: "hosted" } })
      const originalKeys = await keys(home)
      for (const file of pair(home)) {
        const value = JSON.parse(await fs.readFile(file, "utf8"))
        expect(value.readerContract).toBe(currentReader)
        await fs.writeFile(file, JSON.stringify({ ...value, readerContract: oldReader }))
      }
      const originalFiles = await bytes(home)
      const originalInode = (await fs.stat(pair(home)[0]!)).ino
      await expect(readRuntimeHome(home.home, home.identity)).rejects.toThrow()
      expect(await bytes(home)).toEqual(originalFiles)
      const owner = await selectedHomeUpgradeOwner(home, currentReader, () =>
        StorageEventSinks.register({
          id: "home-reader-retained-fixture",
          capture(event) {
            if (event.type !== Changed.type) return
            return { partition: "original-native-owner", payload: event.payload }
          },
          async deliver() {
            throw new Error("Home reader upgrades must not consume retained deliveries")
          },
        }),
      )
      const requestID = "durable-sync-reader-upgrade"
      let expectedDeliveries: Awaited<ReturnType<typeof Storage.query>> = []
      let maintenanceID = ""
      try {
        await owner.run(async () => {
          expectedDeliveries = await seed()
          await runMigrations({ targetDomain: "organization-runtime-home", maintenance: false, output: "silent" })
          expect(await bytes(home)).toEqual(originalFiles)
          const lease = await RuntimeMaintenance.begin({
            purpose: "organization-home-upgrade",
            requestID,
            actor: actor(requestID),
          })
          maintenanceID = lease.maintenanceID
          await expect(upgradeOrganizationHome({ home: home.home, identity: home.identity, lease })).rejects.toThrow(
            "frozen",
          )
          await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
          const open = fs.open
          let lost = false
          using lostAck = spyOn(fs, "open").mockImplementation(async (...args) => {
            const file = await open(...args)
            if (args[0] === pair(home)[0] && typeof args[1] === "number" && !lost) {
              const sync = file.sync.bind(file)
              spyOn(file, "sync").mockImplementationOnce(async () => {
                await sync()
                lost = true
                throw new Error("Lost original reader-five marker acknowledgement")
              })
            }
            return file
          })
          await expect(upgradeOrganizationHome({ home: home.home, identity: home.identity, lease })).rejects.toThrow(
            "Lost original reader-five",
          )
          expect(lost).toBe(true)
          expect((await fs.stat(pair(home)[0]!)).ino).toBe(originalInode)
          expect((await bytes(home)).map((value) => JSON.parse(value).readerContract)).toEqual([
            currentReader,
            oldReader,
          ])
          expect(await Storage.query({ kind: "event_delivery" })).toEqual(expectedDeliveries)
        })
      } finally {
        await owner.close()
      }
      const reopened = await selectedHomeUpgradeOwner(home, currentReader, () =>
        StorageEventSinks.register({
          id: "home-reader-retained-fixture",
          capture(event) {
            if (event.type !== Changed.type) return
            return { partition: "original-native-owner", payload: event.payload }
          },
          async deliver() {
            throw new Error("Home reader upgrades must not consume retained deliveries")
          },
        }),
      )
      try {
        expect(reopened.id).not.toBe(owner.id)
        await reopened.run(() =>
          RuntimeMaintenance.withHomeUpgradeRecovery({ requestID }, async (lease) => {
            expect(lease.maintenanceID).toBe(maintenanceID)
            await expect(
              upgradeOrganizationHome({ home: home.home, identity: home.identity, lease: { ...lease } }),
            ).rejects.toThrow()
            await expect(readRuntimeHome(home.home, home.identity)).rejects.toThrow()
            await upgradeOrganizationHome({ home: home.home, identity: home.identity, lease })
            const completed = await bytes(home)
            await upgradeOrganizationHome({ home: home.home, identity: home.identity, lease })
            expect(await bytes(home)).toEqual(completed)
            expect(completed.map((value) => JSON.parse(value).readerContract)).toEqual([currentReader, currentReader])
            expect(await readRuntimeHome(home.home, home.identity)).toEqual(home)
            expect(await Storage.read(dataKey)).toEqual({ value: "original native bytes" })
            expect(await Storage.query({ kind: "event_delivery" })).toEqual(expectedDeliveries)
            expect(await keys(home)).toBe(originalKeys)
            expect((await fs.stat(pair(home)[0]!)).ino).toBe(originalInode)
            await RuntimeMaintenance.release(lease)
          }),
        )
      } finally {
        await reopened.close()
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

test("reader five does not reinterpret an accepted reader-three to reader-four target after its original native file publication", async () => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "original-reader-four-target-")),
  )
  try {
    const home = await prepareHostedHome({
      baseDirectory: directory,
      origin: "https://organization.example",
      identity: { orgID: "org", hostID: "original-four" },
    })
    for (const file of pair(home)) {
      const value = JSON.parse(await fs.readFile(file, "utf8"))
      await fs.writeFile(file, JSON.stringify({ ...value, readerContract: "native-organization-ownership-v3" }))
    }
    const originalKeys = await keys(home)
    const owner = await selectedHomeUpgradeOwner(home, oldReader)
    const requestID = "original-reader-four-target"
    let retained: RuntimeMaintenance.Info | undefined
    try {
      await owner.run(async () => {
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-home-upgrade",
          requestID,
          actor: actor(requestID),
        })
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
        const actual = await RuntimeMaintenance.assertHeld(lease)
        if (actual.version !== 2) throw new Error("An original native Home upgrade witness is required")
        retained = actual
        const files = HomeOwnershipFile.open({
          root: home.root,
          env: RuntimeContext.current().host.env,
          selected: actual.native.target,
        })
        await RuntimeMaintenance.withFrozen(lease, () => files.advanceReader(actual.native.source))
      })
    } finally {
      await owner.close()
    }
    const original = retained
    if (!original) throw new Error("The original target-four native hold was not captured")
    const before = await bytes(home)
    expect(before.map((value) => JSON.parse(value).readerContract)).toEqual([
      oldReader,
      "native-organization-ownership-v3",
    ])
    const reopened = await selectedHomeUpgradeOwner(home, oldReader)
    try {
      await reopened.run(() =>
        RuntimeMaintenance.withHomeUpgradeRecovery({ requestID }, async (lease) => {
          await expect(upgradeOrganizationHome({ home: home.home, identity: home.identity, lease })).rejects.toThrow(
            "unsupported",
          )
          expect(await bytes(home)).toEqual(before)
          expect(await RuntimeMaintenance.assertHeld(lease)).toEqual(original)
          expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
          expect(await keys(home)).toBe(originalKeys)
        }),
      )
    } finally {
      await reopened.close()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test("reader five rejects targetless original backup and restore holds without changing their native Home", async () => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "targetless-home-hold-")),
  )
  try {
    const home = await prepareHostedHome({
      baseDirectory: directory,
      origin: "https://organization.example",
      identity: { orgID: "org", hostID: "targetless" },
    })
    for (const file of pair(home)) {
      const value = JSON.parse(await fs.readFile(file, "utf8"))
      await fs.writeFile(file, JSON.stringify({ ...value, readerContract: oldReader }))
    }
    const originalFiles = await bytes(home)
    const originalKeys = await keys(home)
    const owner = await selectedHomeUpgradeOwner(home, currentReader)
    try {
      await owner.run(async () => {
        await Storage.write(dataKey, { original: "retained" })
        for (const purpose of ["organization-backup", "organization-restore"] as const) {
          const requestID = `targetless-${purpose}`
          const lease = await RuntimeMaintenance.begin({ purpose, requestID, actor: actor(requestID) })
          await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
          const retained = await RuntimeMaintenance.assertHeld(lease)
          expect(retained.version).toBe(1)
          await expect(upgradeOrganizationHome({ home: home.home, identity: home.identity, lease })).rejects.toThrow(
            "unsupported",
          )
          expect(await RuntimeMaintenance.assertHeld(lease)).toEqual(retained)
          expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
          expect(await bytes(home)).toEqual(originalFiles)
          expect(await keys(home)).toBe(originalKeys)
          expect(await Storage.read(dataKey)).toEqual({ original: "retained" })
          if (purpose === "organization-backup") {
            await RuntimeMaintenance.release(lease)
            expect((await RuntimeMaintenance.status())?.phase).toBe("released")
          } else {
            await expect(RuntimeMaintenance.release(lease)).rejects.toThrow("current-writer reconciliation")
            expect(await RuntimeMaintenance.assertHeld(lease)).toEqual(retained)
            expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
          }
        }
      })
    } finally {
      await owner.close()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
