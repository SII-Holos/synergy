import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { OrganizationRecoveryAdministration as Recovery } from "../src/backup/administration-recovery"
import { OrganizationRecoveryPublication as Publication } from "../src/backup/publication"
import { OrganizationRecoveryPublicationRecords as PublicationRecords } from "../src/backup/publication-records"
import { OrganizationRecovery as RecoveryOwner } from "../src/backup/recovery"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { createHash } from "node:crypto"
import { openOrganizationRecovery } from "../src/service"
import { preparedFixture } from "./support/recovery-administration"

test("public recover resumes its durable Reference after the original pre-reservation call fails", async () => {
  await using f = await preparedFixture()
  const lost = new Error("Original process left after durable selection before retirement reservation")
  using stopped = spyOn(RuntimeMaintenance, "withRetirementCommit").mockImplementationOnce(() => {
    throw lost
  })
  await expect(Recovery.recover(f.input)).rejects.toBe(lost)
  stopped.mockRestore()
  expect((await Bun.file(path.join(f.input.sourceHome, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(
    2,
  )
  expect(await fs.exists(path.join(f.input.work, "reference.json"))).toBe(true)
  const retried = await f.invoke()
  expect(retried.code, retried.stderr).toBe(0)
  expect(JSON.parse(retried.stdout)).toMatchObject({
    state: "ready",
    executionEnabled: false,
    installationID: f.target.installationID,
  })
  expect(await f.materialHash()).toBe(f.originalKey)
}, 30_000)

test("a committed publication with a lost transaction acknowledgement retries through its original receipt", async () => {
  await using f = await preparedFixture()
  const transaction = RuntimeMaintenance.restorationTransaction
  const lost = new Error("Committed current publication acknowledgement lost")
  let committed = false
  using unknown = spyOn(RuntimeMaintenance, "restorationTransaction").mockImplementation(
    async <T>(
      input: Parameters<typeof transaction>[0],
      body: (tx: StoreTransaction) => Promise<T>,
      options?: Parameters<typeof transaction>[2],
    ) => {
      const result = await transaction(input, body, options)
      if (!committed && (await Publication.readIfPresent(f.target.installationID))) {
        committed = true
        throw lost
      }
      return result
    },
  )
  await expect(Recovery.recover(f.input)).rejects.toBe(lost)
  unknown.mockRestore()
  expect(committed).toBe(true)
  await using target = await openOrganizationRecovery({ home: f.input.home })
  expect(await target.run(() => Publication.readIfPresent(f.target.installationID))).toBeDefined()
  expect((await target.run(() => RuntimeMaintenance.status()))?.phase).toBe("recovery-held")
  await target.close()
  const retried = await f.invoke()
  expect(retried.code, retried.stderr).toBe(0)
  expect(JSON.parse(retried.stdout)).toMatchObject({ state: "ready", incarnation: f.target.incarnation })
  expect(await f.materialHash()).toBe(f.originalKey)
}, 30_000)

test("an exact native completion prefix with a lost acknowledgement is repaired from the same SQL publication", async () => {
  await using f = await preparedFixture()
  const complete = HomeRestoration.completePublication
  const lost = new Error("Native completion acknowledgement lost with its original deterministic prefix")
  using interrupted = spyOn(HomeRestoration, "completePublication").mockImplementationOnce(async (permit) => {
    await complete(permit)
    const filename = path.join(f.input.home, ".synergy", "home-restoration.json")
    const original = await fs.readFile(filename)
    const second = original.indexOf(10) + 1
    if (second <= 0 || original.byteLength < second + 8)
      throw new Error("Actual native completion did not produce its canonical frame")
    await fs.truncate(filename, second + 8)
    throw lost
  })
  await expect(Recovery.recover(f.input)).rejects.toThrow()
  interrupted.mockRestore()
  const retried = await f.invoke()
  expect(retried.code, retried.stderr).toBe(0)
  expect(JSON.parse(retried.stdout)).toMatchObject({ state: "ready", installationID: f.target.installationID })
  expect(await f.materialHash()).toBe(f.originalKey)
}, 30_000)

test("partial work is retained without authorizing source retirement", async () => {
  await using f = await preparedFixture()
  await fs.mkdir(f.input.work, { mode: 0o700 })
  const retained = Buffer.from("incomplete original preparation")
  await fs.writeFile(path.join(f.input.work, "partial"), retained)
  const rejected = await f.invoke()
  expect(rejected.code).toBe(1)
  expect(rejected.stderr).toContain("Incomplete")
  expect(await fs.readFile(path.join(f.input.work, "partial"))).toEqual(retained)
  expect((await Bun.file(path.join(f.input.sourceHome, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(
    2,
  )
  await f.source.restart()
  expect((await f.source.service.fetch(new Request("https://organization.example/org/v1/ready"))).status).toBe(200)
}, 30_000)

for (const version of [1, 2] as const)
  test(`a constructed legacy Service publication ${version} survives lost ACK and cold owner retry without rewriting its receipt`, async () => {
    await using f = await preparedFixture()
    const address = PublicationRecords.key(f.target.installationID)
    const write = StoreTransaction.prototype.write
    let constructed = false
    using firstWrite = spyOn(StoreTransaction.prototype, "write").mockImplementation(async function (
      this: StoreTransaction,
      ...args: Parameters<StoreTransaction["write"]>
    ) {
      if (JSON.stringify(args[0]) !== JSON.stringify(address)) return write.apply(this, args)
      if (constructed) throw new Error("An already published legacy receipt must not be written again")
      expect(Storage.current().transaction).toBe(this)
      expect(Storage.inWriteTransaction()).toBe(true)
      expect((await this.readMany([address]))[0]).toBeUndefined()
      const current = PublicationRecords.Receipt.parse(args[1])
      expect(current.version).toBe(3)
      const { version: _version, sourceIdentity: _sourceIdentity, writers, ...fields } = current
      if (version === 1) expect(writers).toBeUndefined()
      else expect(writers).toMatchObject({ hosted: 0, namespaceHash: current.source.current.namespaceHash })
      const legacy = PublicationRecords.Receipt.parse({ ...fields, version, ...(version === 2 ? { writers } : {}) })
      await write.call(this, args[0], legacy, args[2])
      constructed = true
    })
    const serviceOnly = RecoveryOwner.publishServiceOnly
    using selectedOwner = spyOn(RecoveryOwner, "publishServiceOnly").mockImplementation((input) =>
      version === 2 ? RecoveryOwner.publishReconciled({ ...input, writers: [] }) : serviceOnly(input),
    )
    const publish = Publication.write
    const returnedVersions: number[] = []
    using originalPublication = spyOn(Publication, "write").mockImplementation(
      async (...args: Parameters<typeof publish>) => {
        const result = await publish(...args)
        if (result.target.installationID === f.target.installationID) {
          returnedVersions.push(result.version)
        }
        return result
      },
    )
    async function physical() {
      return Storage.snapshot(async (tx) => {
        const rows = await tx.raw.query<{ body: string | Uint8Array | null; revision: bigint | string | number }>(
          "SELECT body,revision FROM storage_records WHERE namespace = ? AND key_text = ?",
          [tx.namespace, JSON.stringify(address)],
        )
        expect(rows).toHaveLength(1)
        const row = rows[0]
        if (!row || row.body === null) throw new Error("Missing original physical legacy publication")
        return {
          bodyHash: createHash("sha256").update(row.body).digest("hex"),
          revision: String(row.revision),
          receipt: await Publication.read(f.target.installationID),
        }
      })
    }
    const transaction = RuntimeMaintenance.restorationTransaction
    const lost = new Error("Original legacy publication COMMIT acknowledgement lost")
    let committed: Awaited<ReturnType<typeof physical>> | undefined
    using unknown = spyOn(RuntimeMaintenance, "restorationTransaction").mockImplementation(
      async <T>(
        input: Parameters<typeof transaction>[0],
        body: (tx: StoreTransaction) => Promise<T>,
        options?: Parameters<typeof transaction>[2],
      ) => {
        const result = await transaction(input, body, options)
        if (!committed && constructed && (await Publication.readIfPresent(f.target.installationID))) {
          committed = await physical()
          expect(committed.receipt.version).toBe(version)
          expect(Object.hasOwn(committed.receipt, "sourceIdentity")).toBe(false)
          throw lost
        }
        return result
      },
    )
    await expect(Recovery.recover(f.input)).rejects.toBe(lost)
    unknown.mockRestore()
    if (!committed) throw new Error("The original legacy publication did not actually commit")
    expect(constructed).toBe(true)
    expect(returnedVersions).toEqual([3])
    const readCold = async () => {
      await using target = await openOrganizationRecovery({ home: f.input.home })
      return await target.run(physical)
    }
    expect(await readCold()).toEqual(committed)
    const cold = await f.invoke()
    expect(cold.code, cold.stderr).toBe(0)
    const retried = JSON.parse(cold.stdout)
    expect(retried).toMatchObject({
      state: "ready",
      installationID: f.target.installationID,
      incarnation: f.target.incarnation,
      executionEnabled: false,
    })
    expect(returnedVersions).toEqual([3])
    expect(await readCold()).toEqual(committed)
    expect(await Recovery.recover(f.input)).toEqual(retried)
    expect(returnedVersions).toEqual([3])
    expect(await readCold()).toEqual(committed)
    expect(await f.materialHash()).toBe(f.originalKey)
  }, 30_000)
