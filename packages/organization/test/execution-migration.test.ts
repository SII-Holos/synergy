import { expect, spyOn, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSessionResources as Resources } from "../src/session-resources"
import { executionFixture } from "./support/execution"
import { commandFixture } from "./support/commands"
import { OrganizationExecutionProtocol as Execution } from "@ericsanchezok/synergy-organization-protocol"

test("historical gateway calls acquire a retention generation without rewriting their signed capabilities", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  const proof = await f.proof("before-retention-migration")
  const capability = await f.run(() => f.gateway.calls.reserve(proof))
  const key = Keys.gatewayCall(f.grant.grantID, proof.proof.callID)
  const legacy = await f.run(async () => {
    const { retentionGeneration: _, ...call } = (await Record.read(Record.GatewayCall, key))!
    const legacy = { ...call, schemaVersion: 1 }
    await Storage.write(key, legacy)
    return legacy
  })
  await f.restart()
  await f.run(async () => {
    expect(await Record.read(Record.GatewayCall, key)).toMatchObject({
      schemaVersion: 2,
      retentionGeneration: 1,
      authorization: capability,
    })
    expect(await Storage.read(key)).toEqual(legacy)
    expect(await f.gateway.calls.authorize(capability)).toEqual(capability)
    const release = Execution.ReleaseProof.parse({
      ...f.binding.proof,
      purpose: "execution-resources-release",
      generation: 1,
      outcome: "completed",
    })
    await f.execution.release({
      proof: release,
      signature: await Execution.signRelease(release, f.machineKeys.privateKey),
    })
    expect((await f.execution.bind(f.binding)).retention.generation).toBe(2)
    await expect(f.gateway.calls.authorize(capability)).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    expect(await f.gateway.calls.inspect(proof)).toMatchObject({ state: "reserved" })
  })
})

test("bound grant retention upgrades from version two without rewriting stored evidence", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  const legacy = await f.run(async () => {
    const { retention: _, ...bound } = f.grant
    const value = { ...bound, schemaVersion: 2 }
    await Storage.write(Keys.executionGrant(bound.grantID), value)
    return value
  })
  await f.restart()
  await f.run(async () => {
    const current = await Record.read(Record.ExecutionGrant, Keys.executionGrant(f.grant.grantID))
    expect(current).toEqual(f.grant)
    expect(current).toMatchObject({ schemaVersion: 3, retention: { state: "held", generation: 1 } })
    expect(await Storage.read(Keys.executionGrant(f.grant.grantID))).toEqual(legacy)
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(1)
  })
})

test("legacy execution metadata upgrades on access without changing acceptance, usage or resource ownership", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  const legacy = await f.run(async () => {
    const { retainedExecutionGrants: _, ...directory } = (await Record.read(
      Record.SessionDirectory,
      Keys.session(f.sessionID),
    ))!
    const session = { ...directory, schemaVersion: 1, executionGrantIDs: [f.grant.grantID] }
    const { retention: __, ...bound } = f.grant
    const grant = { ...bound, schemaVersion: 1, limits: { ...f.grant.limits, calls: 1024 } }
    await Storage.transaction(async () => {
      await Storage.write(Keys.session(f.sessionID), session)
      await Storage.write(Keys.executionGrant(f.grant.grantID), grant)
      await Storage.write(Keys.executionUsage(f.grant.grantID), {
        schemaVersion: 1,
        grantID: f.grant.grantID,
        calls: 4096,
      })
    })
    return { session, grant }
  })
  await f.restart()
  await f.run(async () => {
    expect(await Record.read(Record.ExecutionGrant, Keys.executionGrant(f.grant.grantID))).toEqual(f.grant)
    expect(await Record.read(Record.SessionDirectory, Keys.session(f.sessionID))).toMatchObject({
      schemaVersion: 2,
      retainedExecutionGrants: 1,
    })
    const view = await Directory.get(f.credentials.alice, f.sessionID)
    expect(view).not.toHaveProperty("executionGrantIDs")
    expect(view).not.toHaveProperty("retainedExecutionGrants")
    expect((await Directory.list(f.credentials.alice, "project", { limit: 1 })).items).toEqual([view])
    await expect(
      Resources.set(f.credentials.alice, f.sessionID, { expectedRevision: 1, selection: f.grant.selection }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    expect(await Storage.read(Keys.session(f.sessionID))).toEqual(legacy.session)
    expect(await Storage.read(Keys.executionGrant(f.grant.grantID))).toEqual(legacy.grant)
  })
  const request = await f.proof("after-upgrade")
  const authorization = await f.run(() => f.gateway.calls.reserve(request))
  expect(authorization.permit).toMatchObject({ grantID: f.grant.grantID, rootID: f.grant.rootID })

  const next = f.request("next-task")
  next.input.mode = "task"
  const write = Storage.write
  const failure = spyOn(Storage, "write").mockImplementation(async (key, value) => {
    await write(key, value)
    if (key[1] === "sessions") throw new Error("Fixture directory commit failed")
  })
  try {
    await expect(f.run(() => f.commands.input(f.credentials.alice, next))).rejects.toThrow(
      "Fixture directory commit failed",
    )
  } finally {
    failure.mockRestore()
  }
  await f.run(async () => {
    expect(await Storage.read(Keys.session(f.sessionID))).toEqual(legacy.session)
    expect(await Storage.count({ prefix: ["organization", "execution-grants"] })).toBe(1)
    const admitted = await f.commands.input(f.credentials.alice, next)
    expect(admitted.kind).toBe("admitted")
    expect(await Storage.read(Keys.session(f.sessionID))).toMatchObject({
      schemaVersion: 2,
      retainedExecutionGrants: 2,
    })
    expect(await Storage.read(Keys.session(f.sessionID))).not.toHaveProperty("executionGrantIDs")
  })
  await f.restart()
  await f.run(async () => {
    expect(await f.gateway.calls.reserve(request)).toEqual(authorization)
    expect(await Record.read(Record.ExecutionGrant, Keys.executionGrant(f.grant.grantID))).toEqual(f.grant)
    expect(await Record.read(Record.SessionDirectory, Keys.session(f.sessionID))).toMatchObject({
      schemaVersion: 2,
      retainedExecutionGrants: 2,
    })
    expect(await Record.read(Record.ExecutionUsage, Keys.executionUsage(f.grant.grantID))).toMatchObject({
      calls: 4097,
    })
  })
})

test("damaged legacy ownership cannot become an empty resource lock", async () => {
  await using f = await commandFixture()
  await f.run(async () => {
    const { retainedExecutionGrants: _, ...directory } = (await Record.read(
      Record.SessionDirectory,
      Keys.session(f.sessionID),
    ))!
    for (const executionGrantIDs of [undefined, ["same-grant", "same-grant"], ["../invalid"]]) {
      const retained = { ...directory, schemaVersion: 1, executionGrantIDs }
      await Storage.write(Keys.session(f.sessionID), retained)
      await expect(Directory.get(f.credentials.alice, f.sessionID)).rejects.toThrow()
      await expect(Directory.list(f.credentials.alice, "project", { limit: 1 })).rejects.toThrow()
      expect(await Storage.read(Keys.session(f.sessionID))).toEqual(JSON.parse(JSON.stringify(retained)))
    }
    await Storage.write(Keys.session(f.sessionID), { ...directory, schemaVersion: 3 })
    await expect(Directory.get(f.credentials.alice, f.sessionID)).rejects.toThrow()
  })
})
