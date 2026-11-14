import { expect, test } from "bun:test"
import { OrganizationRecoveryWriters } from "../../src/backup/writers"
import { fixture } from "../support/organization"
import { keys } from "../support/runtime"

test("service-only recovery checks real canonical Runtime registrations rather than an empty caller report", async () => {
  await using source = await fixture()
  const owner = await source.initialize()
  expect(await source.service.maintenance.run(() => OrganizationRecoveryWriters.assertServiceOnly())).toEqual({
    version: 1,
    externalWriters: 0,
  })
  const machine = await keys()
  const response = await owner.request("POST", "/runtimes/member", {
    deviceID: "recovery-device",
    publicKey: machine.publicKey,
  })
  expect(response.status).toBe(200)
  await expect(source.service.maintenance.run(() => OrganizationRecoveryWriters.assertServiceOnly())).rejects.toThrow(
    "reconciliation",
  )
})
