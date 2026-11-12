import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationSourceRetirement as Retirement } from "../../src/backup/source-retirement"
import * as Signing from "../../src/signing"
import { OrganizationCurrentAuthority as Current } from "../../src/backup/current-authority"
import * as Service from "../../src/service"
import { fixture } from "../support/organization"

const target = {
  installationID: crypto.randomUUID(),
  incarnation: crypto.randomUUID(),
  restoreID: "original-target-installation",
  requestHash: "1".repeat(64),
  sourceHash: "2".repeat(64),
  nativeHash: "3".repeat(64),
}
const keys = {
  async current() {
    return { version: "fixture", key: Buffer.alloc(32, 19) }
  },
  async resolve(version: string) {
    if (version !== "fixture") throw new Error("Wrong recovery key")
    return Buffer.alloc(32, 19)
  },
}

test("a real current service retires its original source, then cold completion cannot create public authority", async () => {
  await using instance = await fixture()
  await instance.initialize()
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "source-retirement-"))
  try {
    const reference = await instance.service.maintenance.run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: "source-permanent-retirement",
        actor: {
          kind: "system",
          subjectID: "operator",
          displayName: "Host",
          clientKind: "system",
          requestID: "source-permanent-retirement",
        },
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      const result = await Current.withSource({ lease, directory, buildVersion: "fixture", keys }, async (source) => {
        const reference = await Current.retirementReference(source, target)
        expect(() => Current.retire({ ...source }, reference)).toThrow("original")
        expect(() =>
          Current.retire(source, { ...reference, current: { ...reference.current, namespaceHash: "0".repeat(64) } }),
        ).toThrow("exact")
        const receipt = await Current.retire(source, reference)
        expect(Current.describeRetirement(receipt)).toEqual(reference)
        return reference
      })
      await expect(RuntimeMaintenance.release(lease)).rejects.toThrow("retirement")
      return result
    })
    const ownershipFile = path.join(instance.service.home, ".synergy", "home-ownership.json")
    expect(HomeOwnershipFile.RetirementInfo.parse(await Bun.file(ownershipFile).json()).referenceHash).toMatch(
      /^[a-f0-9]{64}$/,
    )
    await instance.service.close()
    await expect(Service.openOrganizationService({ home: instance.service.home })).rejects.toThrow("owner")
    const cold = await Service.openOrganizationSourceRetirement({ home: instance.service.home, reference })
    try {
      expect("fetch" in cold).toBe(false)
      expect("bootstrapToken" in cold).toBe(false)
      expect("websocket" in cold).toBe(false)
      const receipt = await cold.complete()
      expect(await cold.run(() => Promise.resolve(Current.describeRetirement(receipt)))).toEqual(reference)
      await cold.run(async () => {
        expect(RuntimeContext.isReady()).toBe(false)
        await expect(Storage.write(["arbitrary-cold-mutation"], true)).rejects.toThrow("freezes")
      })
    } finally {
      await cold.close()
    }
    await expect(
      Service.openOrganizationSourceRetirement({
        home: instance.service.home,
        reference: { ...reference, target: { ...target, requestHash: "4".repeat(64) } },
      }),
    ).rejects.toThrow()
    const marker = await fs.readFile(ownershipFile)
    await fs.writeFile(ownershipFile, marker.subarray(0, 43))
    using signing = spyOn(Signing, "loadSigningAuthority")
    const partial = await Service.openOrganizationSourceRetirement({ home: instance.service.home, reference })
    try {
      await partial.complete()
      expect(await fs.readFile(ownershipFile)).toEqual(marker)
      expect(signing).toHaveBeenCalledTimes(0)
    } finally {
      await partial.close()
    }
    const copy = path.join(directory, "copied-home")
    await fs.cp(instance.service.home, copy, { recursive: true })
    await expect(Service.openOrganizationSourceRetirement({ home: copy, reference })).rejects.toThrow("physical")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15_000)

test("cold source completion retains the exact committed reservation before the first file effect", async () => {
  await using instance = await fixture()
  await instance.initialize()
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "source-reservation-"))
  try {
    const reference = await instance.service.maintenance.run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: "cold-source",
        actor: {
          kind: "system",
          subjectID: "operator",
          displayName: "Host",
          clientKind: "system",
          requestID: "cold-source",
        },
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      return Current.withSource({ lease, directory, buildVersion: "fixture", keys }, async (source) => {
        const reference = await Current.retirementReference(source, target)
        await RuntimeMaintenance.reserveRetirement(lease, Retirement.marker(reference).referenceHash)
        return reference
      })
    })
    const filename = path.join(instance.service.home, ".synergy", "home-ownership.json")
    expect(HomeOwnershipFile.Info.parse(await Bun.file(filename).json()).schemaVersion).toBe(2)
    await instance.service.close()
    const cold = await Service.openOrganizationSourceRetirement({ home: instance.service.home, reference })
    try {
      const lost = new Error("Original permanent fence acknowledgement was lost")
      const open = HomeOwnershipFile.open
      using acknowledgement = spyOn(HomeOwnershipFile, "open").mockImplementation((input) => {
        const files = open(input)
        return {
          ...files,
          async retire(...args: Parameters<typeof files.retire>) {
            await files.retire(...args)
            throw lost
          },
        }
      })
      await expect(cold.complete()).rejects.toBe(lost)
      expect(HomeOwnershipFile.Info.parse(await Bun.file(filename).json()).schemaVersion).toBe(4)
      acknowledgement.mockRestore()
      await cold.complete()
    } finally {
      await cold.close()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15_000)

test("source cancellation before the reservation commit preserves its original Home and releases normal maintenance", async () => {
  await using instance = await fixture()
  await instance.initialize()
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "source-fence-cancel-"))
  const controller = new AbortController()
  const reason = new Error("Original source cancelled before permanent intent")
  const reserve = RuntimeMaintenance.reserveRetirement
  using commit = spyOn(RuntimeMaintenance, "reserveRetirement").mockImplementation((...args) => {
    controller.abort(reason)
    return reserve(...args)
  })
  try {
    await instance.service.maintenance.run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: "cancel-source",
        actor: {
          kind: "system",
          subjectID: "operator",
          displayName: "Host",
          clientKind: "system",
          requestID: "cancel-source",
        },
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      await expect(
        Current.withSource(
          { lease, directory, buildVersion: "fixture", keys, signal: controller.signal },
          async (source) => {
            const reference = await Current.retirementReference(source, target)
            await Current.retire(source, reference)
          },
        ),
      ).rejects.toBe(reason)
      expect(await RuntimeMaintenance.retirement(lease.maintenanceID)).toBeUndefined()
      await RuntimeMaintenance.release(lease)
    })
    expect(
      HomeOwnershipFile.Info.parse(
        await Bun.file(path.join(instance.service.home, ".synergy", "home-ownership.json")).json(),
      ).schemaVersion,
    ).toBe(2)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15_000)

test("committed source fence work drains despite observer cancellation and service shutdown", async () => {
  await using instance = await fixture()
  await instance.initialize()
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "source-fence-drain-"))
  const controller = new AbortController()
  const reason = new Error("Original observer stopped after permanent intent committed")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const open = HomeOwnershipFile.open
  using fence = spyOn(HomeOwnershipFile, "open").mockImplementation((input) => {
    const files = open(input)
    return {
      ...files,
      async retire(...args: Parameters<typeof files.retire>) {
        controller.abort(reason)
        entered.resolve()
        await release.promise
        return files.retire(...args)
      },
    }
  })
  let settled = false
  const work = instance.service.maintenance
    .run(async () => {
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: "accepted-source",
        actor: {
          kind: "system",
          subjectID: "operator",
          displayName: "Host",
          clientKind: "system",
          requestID: "accepted-source",
        },
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      return Current.withSource(
        { lease, directory, buildVersion: "fixture", keys, signal: controller.signal },
        async (source) => {
          const reference = await Current.retirementReference(source, target)
          Current.retire(source, reference).catch(() => {})
        },
      )
    })
    .then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      settled = true
    })
  try {
    await Promise.race([
      entered.promise,
      work.then((outcome) => {
        throw outcome.error ?? new Error("Source exited before the accepted native effect")
      }),
    ])
    expect(settled).toBe(false)
    let closed = false
    const closing = instance.service.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    release.resolve()
    expect((await work).error).toBe(reason)
    await closing
    expect(
      HomeOwnershipFile.Info.parse(
        await Bun.file(path.join(instance.service.home, ".synergy", "home-ownership.json")).json(),
      ).schemaVersion,
    ).toBe(4)
  } finally {
    release.resolve()
    await work
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15_000)
