import { expect, spyOn, test } from "bun:test"
import {
  OrganizationResourceProtocol as Resource,
  OrganizationExecutionProtocol as Execution,
  OrganizationCommandProtocol as Command,
  OrganizationGatewayProtocol as Gateway,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { OrganizationResources as Resources } from "../src/resources"
import { OrganizationSessionResources as SessionResources } from "../src/session-resources"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationExecutionGrants } from "../src/execution-grants"
import { commandFixture } from "./support/commands"

async function model(f: Awaited<ReturnType<typeof commandFixture>>) {
  return f.run(async () => {
    const resource = await Resources.create(
      f.credentials.admin,
      Resource.Create.parse({
        name: "Task model",
        scope: { kind: "organization" },
        configuration: {
          protocol: "openai-compatible",
          endpoint: "https://provider.example/v1",
          model: { id: "fixture-model", name: "Fixture", limit: { context: 32768, output: 4096 } },
        },
        credential: { kind: "bearer", value: "private-upstream-key" },
      }),
    )
    await Resources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "account", id: "alice" },
      {
        expectedRevision: 0,
        enabled: true,
      },
    )
    return resource
  })
}

async function task(f: Awaited<ReturnType<typeof commandFixture>>, actor = "alice") {
  const resource = await model(f)
  return f.run(async () => {
    await SessionResources.set(f.credentials.alice, f.sessionID, {
      expectedRevision: 0,
      selection: { modelResourceID: resource.resourceID, connectionResourceIDs: [] },
    })
    if (actor !== "alice") {
      const session = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
      await Storage.write(Keys.session(f.sessionID), { ...session, shareState: "shared" })
    }
    const request = f.request()
    request.input.mode = "task"
    const admission = await f.commands.input(f.credentials[actor], request)
    if (admission.kind !== "admitted") throw new Error("Expected command admission")
    const permit = admission.delivery.authorization.permit
    const acceptedAt = Date.now()
    const receipt = Command.InputResult.parse({
      attempt: {
        schemaVersion: 1,
        permit,
        receivedAt: acceptedAt,
        status: "accepted",
        acceptedAttemptID: permit.attemptID,
      },
      accepted: {
        schemaVersion: 1,
        permit,
        acceptedAt,
        intakeSeq: 1,
        effect: { kind: "inbox", mode: "task", itemID: "inb_resource", messageID: "msg_resource" },
      },
    })
    return { resource, permit, receipt, connection: admission.connection }
  })
}

async function proof(
  f: Awaited<ReturnType<typeof commandFixture>>,
  receipt: Command.InputResult,
  changes: Partial<Execution.BindingProof> = {},
) {
  const proof = Execution.BindingProof.parse({
    schemaVersion: 1,
    purpose: "execution-root-binding",
    orgID: "org",
    deploymentIncarnation: "deployment",
    runtimeID: "runtime-alice",
    connectionEpoch: 1,
    rootID: "msg_resource",
    receipt,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 30_000,
    ...changes,
  })
  return { proof, signature: await Execution.signBinding(proof, f.machineKeys.privateKey) }
}

test("releasing and reacquiring a root preserves its evidence while fencing capabilities from its previous use", async () => {
  await using f = await commandFixture()
  await f.connect()
  const admitted = await task(f)
  const binding = await proof(f, admitted.receipt)
  const grant = await f.run(() => f.execution.bind(binding))
  expect(grant.retention).toEqual({ state: "held", generation: 1 })
  async function reserve(callID: string) {
    const value = Gateway.Proof.parse({
      schemaVersion: 1,
      purpose: "gateway-call",
      orgID: grant.orgID,
      deploymentIncarnation: grant.deploymentIncarnation,
      runtimeID: grant.runtimeID,
      connectionEpoch: 1,
      grantID: grant.grantID,
      sessionID: grant.sessionID,
      rootID: grant.rootID,
      bindingEpoch: grant.bindingEpoch,
      resourceID: grant.selection.modelResourceID,
      callID,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    })
    const request = { proof: value, signature: await Gateway.signRequest(value, f.machineKeys.privateKey) }
    return { request, capability: await f.run(() => f.gateway.calls.reserve(request)) }
  }
  const old = await reserve("before-release")
  expect(await f.run(() => f.gateway.calls.authorize(old.capability))).toEqual(old.capability)
  const value = Execution.ReleaseProof.parse({
    ...binding.proof,
    purpose: "execution-resources-release",
    generation: 1,
    outcome: "completed",
  })
  const release = { proof: value, signature: await Execution.signRelease(value, f.machineKeys.privateKey) }
  const receipt = await f.run(() => f.execution.release(release))
  expect(receipt).toMatchObject({ grantID: grant.grantID, rootID: grant.rootID, generation: 1, outcome: "completed" })
  await f.run(async () => {
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(0)
    expect(await f.execution.release(release)).toEqual(receipt)
    expect(await f.gateway.calls.inspect(old.request)).toMatchObject({ state: "reserved" })
    await expect(f.gateway.calls.authorize(old.capability)).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    await expect(f.gateway.calls.reserve(old.request)).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    const reacquired = await f.execution.bind(binding)
    expect(reacquired).toMatchObject({
      grantID: grant.grantID,
      rootID: grant.rootID,
      boundAt: grant.boundAt,
      retention: { state: "held", generation: 2 },
    })
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(1)
    expect(await f.execution.release(release)).toEqual(receipt)
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(1)
    await expect(f.gateway.calls.authorize(old.capability)).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    await expect(
      f.gateway.calls.start(old.capability, { hash: "1".repeat(64), bytes: 2, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
  })
  const next = await reserve("after-release")
  await f.run(async () => {
    expect(await f.gateway.calls.authorize(next.capability)).toEqual(next.capability)
    expect(await Record.read(Record.ExecutionUsage, Keys.executionUsage(grant.grantID))).toMatchObject({ calls: 2 })
  })
})

test("cancelled accepted intake releases its provisional grant without inventing a native root", async () => {
  await using f = await commandFixture()
  await f.connect()
  const admitted = await task(f)
  const value = Execution.ReleaseProof.parse({
    ...(await proof(f, admitted.receipt)).proof,
    purpose: "execution-resources-release",
    generation: 0,
    outcome: "cancelled",
  })
  const input = { proof: value, signature: await Execution.signRelease(value, f.machineKeys.privateKey) }
  await f.run(async () => {
    const receipt = await f.execution.release(input)
    expect(receipt).toMatchObject({ grantID: admitted.permit.provisionalGrantID, generation: 0, outcome: "cancelled" })
    expect(await f.execution.release(input)).toEqual(receipt)
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(0)
    const { rootID: _, generation: __, outcome: ___, ...received } = value
    const description = Execution.DescriptionProof.parse({ ...received, purpose: "execution-resource-description" })
    expect(
      await f.execution.retention({
        proof: description,
        signature: await Execution.signDescription(description, f.machineKeys.privateKey),
      }),
    ).toMatchObject({ state: "closed", grantID: admitted.permit.provisionalGrantID })
    expect(await Record.read(Record.RootGrant, Keys.rootGrant(f.sessionID, 1, value.rootID))).toBeUndefined()
    await expect(f.execution.bind(await proof(f, admitted.receipt))).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    expect(
      (await f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" })).accepted,
    ).toEqual(admitted.receipt.accepted)
  })
})

test("Session resource selection uses current selection grants and an independent revision", async () => {
  await using f = await commandFixture()
  const resource = await model(f)
  const client = createOrganizationClient({ baseUrl: f.baseUrl, headers: f.apiHeaders() })
  expect((await client.orgSessionResources.get({ sessionID: f.sessionID }, { throwOnError: true })).data).toEqual({
    sessionID: f.sessionID,
    revision: 0,
    selection: null,
  })
  const response = await client.orgSessionResources.set(
    {
      sessionID: f.sessionID,
      orgSessionResourceChange: {
        expectedRevision: 0,
        selection: { modelResourceID: resource.resourceID, connectionResourceIDs: [] },
      },
    },
    { throwOnError: true },
  )
  expect(response.response.status).toBe(200)
  expect(response.data).toEqual({
    sessionID: f.sessionID,
    revision: 1,
    selection: { modelResourceID: resource.resourceID, connectionResourceIDs: [] },
  })
  await f.run(async () => {
    const selection = { modelResourceID: resource.resourceID, connectionResourceIDs: [] }
    const session = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    await Storage.write(Keys.session(f.sessionID), { ...session, shareState: "shared" })
    expect((await SessionResources.get(f.credentials.bob, f.sessionID)).selection).toEqual(selection)
    await expect(
      SessionResources.set(f.credentials.bob, f.sessionID, { expectedRevision: 1, selection }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
    await expect(
      SessionResources.set(f.credentials.admin, f.sessionID, { expectedRevision: 1, selection }),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    await Resources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "account", id: "bob" },
      { expectedRevision: 0, enabled: true },
    )
    expect(
      (await SessionResources.set(f.credentials.bob, f.sessionID, { expectedRevision: 1, selection })).revision,
    ).toBe(2)
    await expect(
      SessionResources.set(f.credentials.alice, f.sessionID, { expectedRevision: 1, selection }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT", currentRevision: 2 } })
    await Resources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "account", id: "bob" },
      { expectedRevision: 1, enabled: false },
    )
    await expect(
      SessionResources.set(f.credentials.bob, f.sessionID, { expectedRevision: 2, selection }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
  })
})

test("task admission reserves a bounded provisional grant with the Session resources, without activating execution", async () => {
  await using f = await commandFixture()
  await f.connect()
  const resource = await model(f)
  await f.run(async () => {
    await SessionResources.set(f.credentials.alice, f.sessionID, {
      expectedRevision: 0,
      selection: { modelResourceID: resource.resourceID, connectionResourceIDs: [] },
    })
    const request = f.request()
    request.input.mode = "task"
    const admission = await f.commands.input(f.credentials.alice, request)
    if (admission.kind !== "admitted") throw new Error("Expected command admission")
    const permit = admission.delivery.authorization.permit
    expect(permit.provisionalGrantID).toBeString()
    const grant = Execution.Grant.parse(await Storage.read(Keys.executionGrant(permit.provisionalGrantID!)))
    expect(grant).toMatchObject({
      state: "provisional",
      attemptID: permit.attemptID,
      admissionID: permit.admissionID,
      sessionID: f.sessionID,
      bindingEpoch: 1,
      actor: { subjectID: "alice" },
      selection: { modelResourceID: resource.resourceID },
    })
    expect(grant).not.toHaveProperty("rootID")
    expect(grant.limits).not.toHaveProperty("calls")
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))?.retainedExecutionGrants).toBe(1)
    await expect(
      SessionResources.set(f.credentials.alice, f.sessionID, {
        expectedRevision: 1,
        selection: { modelResourceID: resource.resourceID, connectionResourceIDs: [] },
      }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
  })
})

test("accepted task resources can be described before materialization without binding or spending its grant", async () => {
  await using f = await commandFixture()
  await f.connect()
  const admitted = await task(f)
  const { purpose: _, rootID: __, ...received } = (await proof(f, admitted.receipt)).proof
  const description = Execution.DescriptionProof.parse({ ...received, purpose: "execution-resource-description" })
  const request = {
    proof: description,
    signature: await Execution.signDescription(description, f.machineKeys.privateKey),
  }
  const read = Storage.read
  using secrets = spyOn(Storage, "read").mockImplementation(async (key) => {
    if (key[1] === "resource-secrets") throw new Error("Descriptor read accessed an upstream secret")
    return read(key)
  })
  const response = await fetch(new URL("/runtime/v1/execution/resources", f.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  })
  expect(response.status).toBe(200)
  const result = Execution.Description.parse(await response.json())
  expect(result.grant).toMatchObject({ grantID: admitted.permit.provisionalGrantID, state: "provisional" })
  expect(result.resources).toMatchObject([
    {
      resourceID: admitted.resource.resourceID,
      definition: { protocol: "openai-compatible", model: { id: "fixture-model" } },
    },
  ])
  expect(JSON.stringify(result)).not.toContain("provider.example")
  expect(JSON.stringify(result)).not.toContain("private-upstream-key")
  expect(JSON.stringify(result)).not.toContain("secretID")
  await f.run(async () => {
    expect(await Record.read(Record.RootGrant, Keys.rootGrant(f.sessionID, 1, "msg_resource"))).toBeUndefined()
    expect(await Record.read(Record.ExecutionUsage, Keys.executionUsage(result.grant.grantID))).toBeUndefined()
    expect(await Record.read(Record.ExecutionGrant, Keys.executionGrant(result.grant.grantID))).toMatchObject({
      state: "provisional",
    })
  })
  const browser = await fetch(new URL("/runtime/v1/execution/resources", f.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://organization.example" },
    body: JSON.stringify(request),
  })
  expect(browser.status).toBe(403)
})

test("resource description preserves B across availability failure and rechecks current ownership after reconnect", async () => {
  await using f = await commandFixture()
  await f.connect()
  const admitted = await task(f)
  async function request(connectionEpoch = 1) {
    const { purpose: _, rootID: __, ...received } = (await proof(f, admitted.receipt, { connectionEpoch })).proof
    const description = Execution.DescriptionProof.parse({ ...received, purpose: "execution-resource-description" })
    return { proof: description, signature: await Execution.signDescription(description, f.machineKeys.privateKey) }
  }
  const signed = await request()
  await expect(f.run(() => f.execution.describe({ ...signed, signature: "0".repeat(128) }))).rejects.toMatchObject({
    data: { code: "PERMISSION_DENIED" },
  })
  await f.run(() =>
    Resources.update(f.credentials.admin, admitted.resource.resourceID, { expectedRevision: 1, state: "disabled" }),
  )
  await expect(f.run(() => f.execution.describe(signed))).rejects.toMatchObject({
    data: { code: "RESOURCE_UNAVAILABLE" },
  })
  await f.run(async () => {
    const retained = await Record.read(
      Record.CommandRequest,
      Keys.commandRequest(admitted.permit.actor.subjectID, admitted.permit.requestID),
    )
    expect(retained?.accepted).toEqual(admitted.receipt.accepted)
    expect(await Record.read(Record.RootGrant, Keys.rootGrant(f.sessionID, 1, "msg_resource"))).toBeUndefined()
    await Resources.update(f.credentials.admin, admitted.resource.resourceID, { expectedRevision: 2, state: "enabled" })
    await Resources.grant(
      f.credentials.admin,
      admitted.resource.resourceID,
      { kind: "account", id: "alice" },
      { expectedRevision: 1, enabled: false },
    )
  })
  await f.restart()
  await f.connect(2)
  const reconnected = await request(2)
  expect((await f.run(() => f.execution.describe(reconnected))).resources[0].revision).toBe(3)
  await expect(f.run(() => f.execution.describe(signed))).rejects.toThrow()
  await f.run(async () => {
    const member = await Record.read(Record.ProjectMember, Keys.projectMember("project", "alice"))
    await Storage.write(Keys.projectMember("project", "alice"), { ...member, role: "reader" })
  })
  await expect(f.run(() => f.execution.describe(reconnected))).rejects.toMatchObject({
    data: { code: "PERMISSION_DENIED" },
  })
})

test("a signed root proof reconciles a lost B receipt and binds once across connection and service restarts", async () => {
  await using f = await commandFixture()
  await f.connect()
  const prepared = await task(f)
  const request = await proof(f, prepared.receipt)
  await f.run(async () => {
    const write = Storage.write
    const interrupted = spyOn(Storage, "write").mockImplementation(async (key, value) => {
      await write(key, value)
      if (key[1] === "root-grants") throw new Error("Root publication interrupted")
    })
    try {
      await expect(f.execution.bind(request)).rejects.toThrow("Root publication interrupted")
    } finally {
      interrupted.mockRestore()
    }
    expect(
      (await Record.read(Record.ExecutionGrant, Keys.executionGrant(prepared.permit.provisionalGrantID!)))?.state,
    ).toBe("provisional")
    expect(await Record.read(Record.RootGrant, Keys.rootGrant(f.sessionID, 1, "msg_resource"))).toBeUndefined()
    expect(
      (await f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" })).attempt.state,
    ).toBe("accepted")
  })
  const machine = createOrganizationClient({ baseUrl: f.baseUrl })
  const response = await machine.orgExecution.bind({ orgExecutionBindingRequest: request }, { throwOnError: true })
  expect(response.response.status).toBe(200)
  const bound = Execution.BoundGrant.parse(response.data)
  expect(bound).toMatchObject({ grantID: prepared.permit.provisionalGrantID, rootID: "msg_resource", state: "bound" })
  expect(JSON.stringify(bound)).not.toContain("private-upstream-key")
  expect(JSON.stringify(bound)).not.toContain("provider.example")
  await f.run(async () => {
    expect(
      (await f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" })).attempt.state,
    ).toBe("accepted")
    expect(await f.execution.bind(request)).toEqual(bound)
    expect(await Storage.count({ prefix: ["organization", "execution-grants"] })).toBe(1)
  })
  await f.restart()
  await f.connect(2)
  await f.run(async () => {
    await expect(f.execution.bind(request)).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    expect(await f.execution.bind(await proof(f, prepared.receipt, { connectionEpoch: 2 }))).toEqual(bound)
  })
})

test("shared work retains its original resources while resource changes authorize the actual selector", async () => {
  await using f = await commandFixture()
  await f.connect()
  const prepared = await task(f, "bob")
  await f.run(async () => {
    expect((await Resources.available(f.credentials.bob, "project", { limit: 50 })).items).toEqual([])
    const bob = (await Record.read(Record.Account, Keys.account("bob")))!
    await Storage.write(Keys.account("bob"), { ...bob, state: "removed", authRevision: bob.authRevision + 1 })
    const bound = await f.execution.bind(await proof(f, prepared.receipt))
    expect(bound.actor.subjectID).toBe("bob")
    expect(bound.selection.modelResourceID).toBe(prepared.resource.resourceID)
    const alice = (await Record.read(Record.Account, Keys.account("alice")))!
    await Storage.write(Keys.account("alice"), { ...alice, state: "removed", authRevision: alice.authRevision + 1 })
    await expect(f.execution.bind(await proof(f, prepared.receipt))).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
  })
})

for (const change of ["expiry", "connection"] as const)
  test(`root publication rolls back when ${change} changes after its writes`, async () => {
    await using f = await commandFixture()
    await f.connect()
    const prepared = await task(f)
    const request = await proof(f, prepared.receipt)
    await f.run(async () => {
      const write = Storage.write
      const clock = spyOn(Date, "now")
      const race = spyOn(Storage, "write").mockImplementation(async (key, value) => {
        await write(key, value)
        if (key[1] !== "root-grants") return
        if (change === "expiry") clock.mockReturnValue(request.proof.expiresAt)
        else f.connections.close()
      })
      try {
        await expect(f.execution.bind(request)).rejects.toThrow()
      } finally {
        race.mockRestore()
        clock.mockRestore()
      }
      expect(
        (await Record.read(Record.ExecutionGrant, Keys.executionGrant(prepared.permit.provisionalGrantID!)))?.state,
      ).toBe("provisional")
      expect(await Record.read(Record.RootGrant, Keys.rootGrant(f.sessionID, 1, "msg_resource"))).toBeUndefined()
      expect(
        (await f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" })).accepted,
      ).toEqual(prepared.receipt.accepted)
    })
  })

test("accepted tasks keep their resource contract without a retained-grant product quota", async () => {
  await using f = await commandFixture()
  await f.connect()
  const prepared = await task(f)
  await f.run(async () => {
    await f.commands.observe(prepared.connection, prepared.receipt)
    for (let index = 1; index < 65; index++) {
      const request = f.request(`task-${index}`)
      request.input.mode = "task"
      const admission = await f.commands.input(f.credentials.alice, request)
      if (admission.kind !== "admitted") throw new Error("Expected task admission")
      const permit = admission.delivery.authorization.permit
      const now = Date.now()
      await f.commands.observe(
        admission.connection,
        Command.InputResult.parse({
          attempt: {
            schemaVersion: 1,
            permit,
            receivedAt: now,
            status: "accepted",
            acceptedAttemptID: permit.attemptID,
          },
          accepted: {
            schemaVersion: 1,
            permit,
            acceptedAt: now,
            intakeSeq: index + 1,
            effect: { kind: "inbox", mode: "task", itemID: `inb_${index}`, messageID: `msg_${index}` },
          },
        }),
      )
    }
    expect(await Storage.count({ prefix: ["organization", "execution-grants"] })).toBe(65)
    expect(await Storage.count({ prefix: ["organization", "command-attempts"] })).toBe(65)
    const directory = await Record.read(Record.SessionDirectory, Keys.session(f.sessionID))
    expect(directory).toMatchObject({ retainedExecutionGrants: 65 })
    expect(directory).not.toHaveProperty("executionGrantIDs")
    await expect(
      SessionResources.set(f.credentials.alice, f.sessionID, {
        expectedRevision: 1,
        selection: { modelResourceID: prepared.resource.resourceID, connectionResourceIDs: [] },
      }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
  })
})

test("binding rejects altered proofs, unaccepted attempts, disabled resources and changed ownership", async () => {
  await using f = await commandFixture()
  await f.connect()
  const prepared = await task(f)
  const original = await proof(f, prepared.receipt)
  await f.run(async () => {
    await expect(f.execution.bind({ ...original, signature: "0".repeat(128) })).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    await expect(f.execution.bind({ ...original, proof: { ...original.proof, rootID: "msg_other" } })).rejects.toThrow()
    const unknown = structuredClone(prepared.receipt)
    if (unknown.attempt.status !== "accepted") throw new Error("Expected an accepted attempt fixture")
    unknown.attempt.permit.attemptID = "unadmitted"
    unknown.attempt.acceptedAttemptID = "unadmitted"
    unknown.accepted!.permit.attemptID = "unadmitted"
    await expect(f.execution.bind(await proof(f, unknown))).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
    await expect(
      f.execution.bind(
        await proof(f, prepared.receipt, { issuedAt: Date.now() - 2_000, expiresAt: Date.now() - 1_000 }),
      ),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    await Resources.update(f.credentials.admin, prepared.resource.resourceID, {
      expectedRevision: 1,
      state: "disabled",
    })
    await expect(f.execution.bind(original)).rejects.toMatchObject({ data: { code: "RESOURCE_UNAVAILABLE" } })
    await Resources.update(f.credentials.admin, prepared.resource.resourceID, { expectedRevision: 2, state: "enabled" })
    const session = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    await Storage.write(Keys.session(f.sessionID), { ...session, handoffID: "handoff" })
    await expect(f.execution.bind(original)).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
    await Storage.write(Keys.session(f.sessionID), { ...session, bindingEpoch: 2, nextBindingEpoch: 3 })
    await expect(f.execution.bind(original)).rejects.toMatchObject({ data: { code: "STALE_BINDING" } })
    await Storage.write(Keys.session(f.sessionID), session)
    const member = (await Record.read(Record.ProjectMember, Keys.projectMember("project", "alice")))!
    await Storage.write(Keys.projectMember("project", "alice"), { ...member, role: "reader" })
    await expect(f.execution.bind(original)).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    await Storage.write(Keys.projectMember("project", "alice"), member)
    const project = (await Record.read(Record.Project, Keys.project("project")))!
    await Storage.write(Keys.project("project"), { ...project, state: "archived" })
    expect((await f.execution.bind(original)).state).toBe("bound")
  })
  const browser = await fetch(new URL("/runtime/v1/execution/bind", f.baseUrl), {
    method: "POST",
    headers: { ...f.apiHeaders(), "content-type": "application/json" },
    body: JSON.stringify(original),
  })
  expect(browser.status).toBe(403)
})

test("provisional admission, rejection and root indexes commit atomically without losing reconciliation facts", async () => {
  await using f = await commandFixture()
  await f.connect()
  const resource = await model(f)
  await f.run(async () => {
    await SessionResources.set(f.credentials.alice, f.sessionID, {
      expectedRevision: 0,
      selection: { modelResourceID: resource.resourceID, connectionResourceIDs: [] },
    })
    const request = f.request()
    request.input.mode = "task"
    const write = Storage.write
    const failAdmission = spyOn(Storage, "write").mockImplementation(async (key, value) => {
      await write(key, value)
      if (key[1] === "command-attempts") throw new Error("Admission failed after grant reservation")
    })
    try {
      await expect(f.commands.input(f.credentials.alice, request)).rejects.toThrow("Admission failed")
    } finally {
      failAdmission.mockRestore()
    }
    expect(await Storage.count({ prefix: ["organization", "execution-grants"] })).toBe(0)
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))?.retainedExecutionGrants).toBe(0)
    const admitted = await f.commands.input(f.credentials.alice, request)
    if (admitted.kind !== "admitted") throw new Error("Expected admission")
    const permit = admitted.delivery.authorization.permit
    const result = Command.Result.parse({
      attempt: { schemaVersion: 1, permit, receivedAt: Date.now(), status: "rejected", reason: "SESSION_UNAVAILABLE" },
    })
    await f.commands.observe(admitted.connection, result)
    expect((await Record.read(Record.ExecutionGrant, Keys.executionGrant(permit.provisionalGrantID!)))?.state).toBe(
      "closed",
    )
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))?.retainedExecutionGrants).toBe(0)
    await expect(OrganizationExecutionGrants.reject(permit)).rejects.toMatchObject({
      data: { code: "INVALID_REQUEST" },
    })
    expect(
      (await f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: request.requestID })).attempt
        .state,
    ).toBe("rejected")
    const skipped = await f.commands.prepareSkip(permit.attemptID, admitted.connection)
    await f.commands.observe(admitted.connection, {
      ...result,
      skip: { schemaVersion: 1, permit: skipped.permit, receivedAt: Date.now() },
    })
    await SessionResources.set(f.credentials.alice, f.sessionID, {
      expectedRevision: 1,
      selection: { modelResourceID: resource.resourceID, connectionResourceIDs: [] },
    })
    const next = f.request("another-task")
    next.input.mode = "task"
    const subsequent = await f.commands.input(f.credentials.alice, next)
    if (subsequent.kind !== "admitted") throw new Error("Expected subsequent admission")
    await f.commands.observe(admitted.connection, result)
    await Storage.transaction(() => OrganizationExecutionGrants.reject(permit))
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))?.retainedExecutionGrants).toBe(1)
    expect((await Record.read(Record.CommandState, Keys.commandState(f.sessionID)))?.pendingAttemptID).toBe(
      subsequent.delivery.authorization.permit.attemptID,
    )
  })
})
