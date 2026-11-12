import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { openOrganizationRecovery } from "../src/service"
import { OrganizationRecoveryWriters as Writers } from "../src/backup/writers"
import { OrganizationRecoveryAdministration as Recovery } from "../src/backup/administration-recovery"
import { preparedFixture } from "./support/recovery-administration"

test("a changed canonical H1 binary reference is rejected before irreversible service recovery", async () => {
  await using f = await preparedFixture()
  const address = ["organization", "retained-binary"]
  const replacement = Buffer.from("changed current H1 bytes after H0")
  await f.source.restart()
  await f.source.service.maintenance.run(() => Storage.writeBinary(address, replacement))
  expect(Buffer.from(await f.source.service.maintenance.run(() => Storage.readBinary(address)))).toEqual(replacement)
  await f.source.service.close()
  const recovered = await f.invoke()
  expect(recovered.code).toBe(1)
  expect(recovered.stderr).toContain("artifact")
  expect((await Bun.file(path.join(f.input.sourceHome, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(
    2,
  )
  await f.source.restart()
  const status = await f.source.service.maintenance.run(() => RuntimeMaintenance.status())
  expect(status?.phase).toBe("released")
  if (!status) throw new Error("Original maintenance operation was not retained")
  expect(
    await f.source.service.maintenance.run(() => RuntimeMaintenance.retirement(status.maintenanceID)),
  ).toBeUndefined()
  expect(Buffer.from(await f.source.service.maintenance.run(() => Storage.readBinary(address)))).toEqual(replacement)
  await using target = await openOrganizationRecovery({ home: f.input.home })
  expect(Buffer.from(await target.run(() => Storage.readBinary(address)))).toEqual(
    Buffer.from("original retained bytes"),
  )
  expect((await target.run(() => RuntimeMaintenance.status()))?.phase).toBe("recovery-held")
  expect(await f.materialHash()).toBe(f.originalKey)
}, 30_000)

for (const delta of ["missing", "additional"] as const) {
  test(`a ${delta} H1 artifact key is rejected before reserving retirement`, async () => {
    await using f = await preparedFixture()
    await f.source.restart()
    await f.source.service.maintenance.run(async () => {
      if (delta === "missing") await Storage.removeTree(["organization", "retained-binary"])
      else
        await Storage.transaction(() =>
          Storage.publishBinaryReference(["organization", "retained-binary"], ["organization", "new-reference"]),
        )
    })
    await f.source.service.close()
    const recovered = await f.invoke()
    expect(recovered.code).toBe(1)
    expect(recovered.stderr).toContain("artifact")
    expect(
      (await Bun.file(path.join(f.input.sourceHome, ".synergy", "home-ownership.json")).json()).schemaVersion,
    ).toBe(2)
    await f.source.restart()
    const status = await f.source.service.maintenance.run(() => RuntimeMaintenance.status())
    expect(status?.phase).toBe("released")
    if (!status) throw new Error("Missing original maintenance operation")
    expect(
      await f.source.service.maintenance.run(() => RuntimeMaintenance.retirement(status.maintenanceID)),
    ).toBeUndefined()
  }, 30_000)
}

test("unchanged artifact metadata cannot certify corrupt actual Target bytes", async () => {
  await using f = await preparedFixture()
  await using target = await openOrganizationRecovery({ home: f.input.home })
  await target.run(async () => {
    const reference = (await Storage.artifactReferences({ prefix: ["organization", "retained-binary"], limit: 1 }))[0]
    if (!reference) throw new Error("Original imported binary was not retained")
    const filename = path.join(Storage.current().artifactDirectory, "agent-artifacts", reference.location.pack)
    const file = await fs.open(filename, "r+")
    try {
      const byte = Buffer.alloc(1)
      await file.read(byte, 0, 1, reference.location.blockOffset)
      byte[0] = byte[0]! ^ 255
      await file.write(byte, 0, 1, reference.location.blockOffset)
      await file.sync()
    } finally {
      await file.close()
    }
    expect((await Storage.artifactReferences({ prefix: reference.key, limit: 1 }))[0]?.location).toEqual(
      reference.location,
    )
  })
  await target.close()
  const recovered = await f.invoke()
  expect(recovered.code).toBe(1)
  expect((await Bun.file(path.join(f.input.sourceHome, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(
    2,
  )
  await f.source.restart()
  expect((await f.source.service.maintenance.run(() => RuntimeMaintenance.status()))?.phase).toBe("released")
}, 30_000)

test("a caught final artifact mismatch still rolls back the actual original Target transaction", async () => {
  await using f = await preparedFixture()
  const seal = Writers.sealPreflight
  let caught: unknown
  using changed = spyOn(Writers, "sealPreflight").mockImplementationOnce(async (tx) => {
    await Storage.removeTree(["organization", "retained-binary"])
    try {
      await seal(tx)
    } catch (error) {
      caught = error
    }
  })
  await expect(Recovery.recover(f.input)).rejects.toThrow("artifact preflight")
  changed.mockRestore()
  expect(caught).toBeDefined()
  await using target = await openOrganizationRecovery({ home: f.input.home })
  expect(Buffer.from(await target.run(() => Storage.readBinary(["organization", "retained-binary"])))).toEqual(
    Buffer.from("original retained bytes"),
  )
  expect((await target.run(() => RuntimeMaintenance.status()))?.phase).toBe("recovery-held")
  await target.close()
  const retried = await f.invoke()
  expect(retried.code, retried.stderr).toBe(0)
  expect(JSON.parse(retried.stdout)).toMatchObject({ state: "ready", installationID: f.target.installationID })
  expect(await f.materialHash()).toBe(f.originalKey)
}, 30_000)
