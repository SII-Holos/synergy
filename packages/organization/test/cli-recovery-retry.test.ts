import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import type { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { OrganizationRecoveryAdministration as Recovery } from "../src/backup/administration-recovery"
import { OrganizationRecoveryPublication as Publication } from "../src/backup/publication"
import { openOrganizationRecovery } from "../src/service"
import { preparedFixture } from "./support/recovery-administration"

test("public recover resumes its durable Reference after the original pre-reservation call fails", async () => {
  await using f = await preparedFixture()
  const lost = new Error("Original process left after durable selection before retirement reservation")
  using stopped = spyOn(RuntimeMaintenance, "reserveRetirement").mockImplementationOnce(() => {
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
