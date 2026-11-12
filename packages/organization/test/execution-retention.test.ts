import { expect, test } from "bun:test"
import { OrganizationExecutionProtocol as Execution } from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { executionFixture } from "./support/execution"

test("retention inspection refuses a stored grant associated with a different native root", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  const { rootID: _, purpose: __, ...received } = f.binding.proof
  const proof = Execution.DescriptionProof.parse({ ...received, purpose: "execution-resource-description" })
  const request = { proof, signature: await Execution.signDescription(proof, f.machineKeys.privateKey) }
  await f.run(async () => {
    await Storage.write(Keys.executionGrant(f.grant.grantID), { ...f.grant, rootID: "different-root" })
    await expect(f.execution.retention(request)).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
  })
})

test("current drivers can inspect retained authority after resource and role revocation without reacquiring it", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  const { rootID: _, purpose: __, ...received } = f.binding.proof
  const proof = Execution.DescriptionProof.parse({ ...received, purpose: "execution-resource-description" })
  const request = { proof, signature: await Execution.signDescription(proof, f.machineKeys.privateKey) }
  await f.run(async () => {
    const key = Keys.resource(f.grant.orgID, f.grant.selection.modelResourceID)
    const resource = (await Record.read(Record.Resource, key))!
    await Storage.write(key, { ...resource, state: "disabled" })
    await Storage.remove(Keys.projectMember(f.grant.projectID, "alice"))
    const session = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    await Storage.write(Keys.session(f.sessionID), { ...session, handoffID: "handoff" })
    await expect(f.execution.describe(request)).rejects.toThrow()
    expect(await f.execution.retention(request)).toEqual(f.grant)
  })
  const release = Execution.ReleaseProof.parse({
    ...f.binding.proof,
    purpose: "execution-resources-release",
    generation: 1,
    outcome: "completed",
  })
  const signed = { proof: release, signature: await Execution.signRelease(release, f.machineKeys.privateKey) }
  await f.run(() => f.execution.release(signed))
  const client = createOrganizationClient({ baseUrl: f.baseUrl })
  const response = await client.orgExecution.retention(
    { orgExecutionRetentionRequest: request },
    { throwOnError: true },
  )
  expect(response.response.status).toBe(200)
  expect(Execution.Grant.parse(response.data)).toMatchObject({
    grantID: f.grant.grantID,
    retention: { state: "released", generation: 1 },
  })
  await f.run(async () => {
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(0)
    await expect(f.execution.bind(f.binding)).rejects.toThrow()
    await expect(
      f.execution.retention({ ...request, proof: { ...proof, runtimeID: "other-runtime" } }),
    ).rejects.toThrow()
    const key = Keys.session(f.sessionID)
    const session = (await Record.read(Record.SessionDirectory, key))!
    await Storage.write(key, {
      ...session,
      bindingEpoch: session.bindingEpoch + 1,
      nextBindingEpoch: session.nextBindingEpoch + 1,
    })
    await expect(f.execution.retention(request)).rejects.toMatchObject({ data: { code: "STALE_BINDING" } })
  })
})
