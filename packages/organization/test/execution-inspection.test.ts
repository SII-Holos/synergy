import { expect, spyOn, test } from "bun:test"
import {
  OrganizationExecutionProtocol as Execution,
  OrganizationCommandProtocol as Command,
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { executionFixture } from "./support/execution"
import { OrganizationExecutionIndex as Index } from "../src/execution-index"
import { OrganizationSharing } from "../src/sharing"
import { OrganizationAuthorityHistory as History } from "../src/authority-history"
import { createHandoffs, registerHandoffAuthorityHistory } from "../src/handoff"
import { createExecutionGrants } from "../src/execution-grants"
import { connection, keys } from "./support/runtime"

type Fixture = Awaited<ReturnType<typeof executionFixture>>
async function inspect(f: Fixture, changes: Partial<Execution.InspectionProof> = {}) {
  const proof = Execution.InspectionProof.parse({
    ...f.binding.proof,
    purpose: "execution-retention-inspection",
    rootID: f.grant.rootID,
    grantID: f.grant.grantID,
    generation: 1,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 30_000,
    ...changes,
  })
  return { proof, signature: await Execution.signInspection(proof, f.machineKeys.privateKey) }
}

test("cleanup inspection returns the exact old generation receipt while current retention is reacquired", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  const request = await inspect(f)
  expect(await f.run(() => f.execution.retention(request))).toMatchObject({
    state: "known",
    rootID: f.grant.rootID,
    originGrantID: f.grant.grantID,
    requestedGrantID: f.grant.grantID,
    requestedGeneration: 1,
    grant: { grantID: f.grant.grantID, retention: { state: "held", generation: 1 } },
  })
  const releaseProof = Execution.ReleaseProof.parse({
    ...f.binding.proof,
    purpose: "execution-resources-release",
    grantID: f.grant.grantID,
    generation: 1,
    outcome: "completed",
  })
  const receipt = await f.run(async () =>
    f.execution.release({
      proof: releaseProof,
      signature: await Execution.signRelease(releaseProof, f.machineKeys.privateKey),
    }),
  )
  expect((await f.run(() => f.execution.bind(f.binding))).retention).toMatchObject({ state: "held", generation: 2 })
  const historical = Execution.Inspection.parse(await f.run(() => f.execution.retention(request)))
  expect(historical).toMatchObject({
    state: "known",
    requestedGeneration: 1,
    grant: { retention: { state: "held", generation: 2 } },
    release: receipt,
  })
  await f.run(async () => {
    const resource = (await Record.read(
      Record.Resource,
      Keys.resource(f.grant.orgID, f.grant.selection.modelResourceID),
    ))!
    await Storage.write(Keys.resource(resource.orgID, resource.resourceID), { ...resource, state: "disabled" })
    await Storage.remove(Keys.projectMember("project", "alice"))
    const directory = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    await Storage.write(Keys.session(f.sessionID), { ...directory, handoffID: "another-pending-handoff" })
    expect(await f.execution.retention(request)).toMatchObject({ state: "known", release: receipt })
    expect(await Record.read(Record.ExecutionGrant, Keys.executionGrant(f.grant.grantID))).toMatchObject({
      retention: { state: "held", generation: 2 },
    })
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(1)
  })
  await expect(
    f.run(async () => f.execution.retention(await inspect(f, { grantID: "missing-grant" }))),
  ).rejects.toThrow()
})

async function continuationFixture() {
  const f = await executionFixture({
    endpoint: "https://provider.example/v1",
    sync: { receipt: (lease, query) => handoffs.syncBatchReceipt(lease, query) },
  })
  const handoffs = createHandoffs({ connections: f.connections, signing: f.signing })
  return { ...f, handoffs }
}

async function continued(f: Awaited<ReturnType<typeof continuationFixture>>) {
  await f.connect(2, true, false, false, true, Handoff.syncTransferBridge)
  const targetKeys = await keys()
  const target = await f.run(async () => {
    const record = (await Record.read(Record.RuntimeRegistration, Keys.runtime("runtime-bob")))!
    const value = Record.RuntimeRegistration.parse({ ...record, connectionEpoch: 0, publicKey: targetKeys.publicKey })
    await Storage.write(Keys.runtime(value.runtimeID), value)
    History.register()
    registerHandoffAuthorityHistory()
    await History.initialize({ schemaVersion: 1, orgID: "org", deploymentIncarnation: "deployment", createdAt: 1 })
    return value
  })
  const socket = new WebSocket(f.baseUrl.replace(/^http/, "ws"))
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = reject
    })
    const signed = await connection(target, targetKeys.privateKey, 1)
    signed.proof.handshake.capabilities.push("commands", "handoffs", "sync")
    signed.proof.handshake.schemas.commands = 1
    signed.proof.handshake.schemas.handoffs = Handoff.syncTransferBridge
    signed.proof.handshake.schemas.sync = Sync.observationVersion
    signed.signature = await Runtime.sign(signed.proof, targetKeys.privateKey)
    const connected = Promise.withResolvers<unknown>()
    socket.onmessage = (event) => connected.resolve(JSON.parse(String(event.data)))
    socket.send(JSON.stringify(signed))
    Runtime.Connected.parse(await connected.promise)
    const handoffs = f.handoffs
    const execution = createExecutionGrants({
      admissions: f.commands,
      connections: f.connections,
      handoffs,
      assertResourcesDrained(id) {
        f.gateway.models.assertDrained(id)
        f.gateway.connections.assertDrained(id)
      },
    })
    const handoff = await f.run(async () => {
      await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
      const view = await handoffs.prepare(f.credentials.alice, f.sessionID, {
        handoffID: "inspection-source-cancel",
        targetRuntimeID: target.runtimeID,
        expectedBindingEpoch: 1,
        expectedControlRevision: 0,
        mappingPlanRevision: 1,
      })
      await handoffs.cancel(f.credentials.alice, view.handoffID)
      const proof = Handoff.Proof.parse({
        schemaVersion: 1,
        orgID: "org",
        deploymentIncarnation: "deployment",
        handoffID: view.handoffID,
        sessionID: f.sessionID,
        sourceRuntimeID: f.grant.runtimeID,
        targetRuntimeID: target.runtimeID,
        fromEpoch: 1,
        toEpoch: view.toEpoch,
        mappingPlanRevision: 1,
        shareGeneration: 1,
        purpose: "source-cancelled",
        manifestHash: null,
        gateCancelled: true,
        paused: true,
      })
      await handoffs.proof({ proof, signature: await Handoff.signProof(proof, f.machineKeys.privateKey) })
      return view
    })
    return {
      execution,
      async control(requestID: string, version: number) {
        return f.run(async () => {
          const control: Command.Control = { operation: "continue", pausedSince: 10 + version, controlVersion: version }
          const admitted = await f.commands.control(
            f.credentials.alice,
            Command.ControlRequest.parse({
              schemaVersion: 1,
              orgID: "org",
              projectID: "project",
              sessionID: f.sessionID,
              runtimeID: f.grant.runtimeID,
              requestID,
              control,
            }),
          )
          if (admitted.kind !== "admitted") throw new Error("Expected accepted control admission")
          const permit = admitted.delivery.authorization.permit
          const receipt = Command.ControlResult.parse({
            attempt: {
              schemaVersion: 1,
              permit,
              receivedAt: Date.now(),
              status: "accepted",
              acceptedAttemptID: permit.attemptID,
            },
            accepted: {
              schemaVersion: 1,
              permit,
              acceptedAt: Date.now(),
              intakeSeq: version + 2,
              effect: {
                kind: "control",
                operation: "continue",
                controlVersion: version + 1,
                pausedSince: 10 + version,
                itemID: "inb_" + requestID,
                messageID: "msg_" + requestID,
                rootID: f.grant.rootID,
              },
            },
          })
          return Execution.Continuation.parse({ handoffID: handoff.handoffID, receipt })
        })
      },
      [Symbol.dispose]() {
        socket.close()
      },
    }
  } catch (error) {
    socket.close()
    throw error
  }
}
function description(proof: Execution.InspectionProof) {
  return Execution.DescriptionProof.parse({
    schemaVersion: proof.schemaVersion,
    purpose: "execution-resource-description",
    orgID: proof.orgID,
    deploymentIncarnation: proof.deploymentIncarnation,
    runtimeID: proof.runtimeID,
    connectionEpoch: proof.connectionEpoch,
    receipt: proof.receipt,
    continuation: proof.continuation,
    issuedAt: proof.issuedAt,
    expiresAt: proof.expiresAt,
  })
}

test("canonical control inspection proves absence before minting and resolves the exact grant after description", async () => {
  await using f = await continuationFixture()
  using c = await continued(f)
  const control = await c.control("first-control", 0)
  const request = await inspect(f, {
    connectionEpoch: 2,
    grantID: undefined,
    generation: undefined,
    continuation: control,
  })
  await f.run(async () => {
    await expect(c.execution.retention(request)).rejects.toThrow("owning migration")
    await Index.controlMigration.up(() => {})
    const count = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants
    expect(await c.execution.retention(request)).toMatchObject({
      state: "absent",
      controlAdmissionID: control.receipt.accepted!.permit.admissionID,
    })
    expect(await c.execution.retention(request)).toMatchObject({ state: "absent" })
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(count)
    const proof = description(request.proof)
    const created = await c.execution.describe({
      proof,
      signature: await Execution.signDescription(proof, f.machineKeys.privateKey),
    })
    expect(await c.execution.retention(request)).toMatchObject({
      state: "known",
      grant: { grantID: created.grant.grantID, state: "provisional" },
    })
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(count)
    await Storage.remove([
      "organization",
      "execution-control-grants",
      f.sessionID,
      "1",
      control.receipt.accepted!.permit.admissionID,
    ])
    await expect(c.execution.retention(request)).rejects.toThrow("does not cover")
    await Index.controlMigration.up(() => {})
    expect(await c.execution.retention(request)).toMatchObject({
      state: "known",
      grant: { grantID: created.grant.grantID },
    })
  })
})

test("historical exact control grants and terminal receipts remain inspectable after the root pointer changes and storage restarts", async () => {
  await using f = await continuationFixture()
  using c = await continued(f)
  await f.run(() => Index.controlMigration.up(() => {}))
  const firstControl = await c.control("old-control", 0)
  const firstInspection = await inspect(f, {
    connectionEpoch: 2,
    continuation: firstControl,
    grantID: undefined,
    generation: undefined,
  })
  const firstDescription = description(firstInspection.proof)
  const first = await f.run(async () =>
    c.execution.describe({
      proof: firstDescription,
      signature: await Execution.signDescription(firstDescription, f.machineKeys.privateKey),
    }),
  )
  const binding = Execution.BindingProof.parse({ ...f.binding.proof, connectionEpoch: 2, continuation: firstControl })
  const bound = await f.run(async () =>
    c.execution.bind({ proof: binding, signature: await Execution.signBinding(binding, f.machineKeys.privateKey) }),
  )
  expect(bound.grantID).toBe(first.grant.grantID)
  const release = Execution.ReleaseProof.parse({
    ...binding,
    purpose: "execution-resources-release",
    grantID: bound.grantID,
    generation: 1,
    outcome: "completed",
  })
  const signedRelease = { proof: release, signature: await Execution.signRelease(release, f.machineKeys.privateKey) }
  const receipt = await f.run(() => c.execution.release(signedRelease))
  const nextControl = await c.control("new-control", 1)
  const next = await inspect(f, {
    connectionEpoch: 2,
    continuation: nextControl,
    grantID: undefined,
    generation: undefined,
  })
  const nextDescription = description(next.proof)
  const successor = await f.run(async () =>
    c.execution.describe({
      proof: nextDescription,
      signature: await Execution.signDescription(nextDescription, f.machineKeys.privateKey),
    }),
  )
  expect(successor.grant.grantID).not.toBe(bound.grantID)
  const historical = await inspect(f, {
    connectionEpoch: 2,
    continuation: firstControl,
    grantID: bound.grantID,
    generation: 1,
  })
  await f.run(async () => {
    expect(await c.execution.retention(historical)).toMatchObject({
      state: "known",
      grant: { grantID: bound.grantID },
      release: receipt,
    })
    expect(await c.execution.release(signedRelease)).toEqual(receipt)
    const wrong = await inspect(f, {
      connectionEpoch: 2,
      continuation: nextControl,
      grantID: bound.grantID,
      generation: 1,
    })
    await expect(c.execution.retention(wrong)).rejects.toThrow()
    const wrongRelease = Execution.ReleaseProof.parse({ ...release, generation: 0, outcome: "cancelled" })
    await expect(
      c.execution.release({
        proof: wrongRelease,
        signature: await Execution.signRelease(wrongRelease, f.machineKeys.privateKey),
      }),
    ).rejects.toThrow()
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(1)
  })
  await f.restart()
  await f.connect(3, true, false, false, true)
  const renewed = await inspect(f, {
    connectionEpoch: 3,
    continuation: firstControl,
    grantID: bound.grantID,
    generation: 1,
  })
  expect(await f.run(() => c.execution.retention(renewed))).toMatchObject({ state: "known", release: receipt })
  expect(
    await f.run(async () =>
      c.execution.release({
        proof: { ...release, connectionEpoch: 3 },
        signature: await Execution.signRelease({ ...release, connectionEpoch: 3 }, f.machineKeys.privateKey),
      }),
    ),
  ).toEqual(receipt)
})

test("mounted retention inspection reconciles an unknown committed bind without another acquisition", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  const proof = Execution.ReleaseProof.parse({
    ...f.binding.proof,
    purpose: "execution-resources-release",
    generation: 1,
    outcome: "completed",
  })
  await f.run(async () =>
    f.execution.release({ proof, signature: await Execution.signRelease(proof, f.machineKeys.privateKey) }),
  )
  let acquisitions = 0
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const response = await fetch(new URL(path, f.baseUrl), {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
      })
      if (path.endsWith("/execution/bind")) {
        acquisitions++
        expect(response.status).toBe(200)
        await response.arrayBuffer()
        return Response.json(
          {
            code: "SERVICE_UNAVAILABLE",
            message: "Committed bind reply was lost",
            retryable: false,
            outcome: "unknown",
          },
          { status: 503 },
        )
      }
      return response
    },
  })
  try {
    const unknown = await fetch(new URL("/runtime/v1/execution/bind", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(f.binding),
    })
    expect(unknown.status).toBe(503)
    await unknown.arrayBuffer()
    const request = await inspect(f, { generation: undefined })
    const response = await fetch(new URL("/runtime/v1/execution/retention", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    })
    expect(response.status).toBe(200)
    expect(Execution.Inspection.parse(await response.json())).toMatchObject({
      state: "known",
      grant: { grantID: f.grant.grantID, retention: { state: "held", generation: 2 } },
    })
    expect(acquisitions).toBe(1)
    for (const headers of [
      new Headers({ origin: "https://organization.example" }),
      new Headers({ cookie: "not-a-machine" }),
    ]) {
      headers.set("content-type", "application/json")
      const rejected = await fetch(new URL("/runtime/v1/execution/retention", proxy.url), {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      })
      expect(rejected.status).toBe(403)
      await rejected.arrayBuffer()
    }
    const description = await fetch(new URL("/runtime/v1/execution/resources", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    })
    expect(description.status).toBe(400)
    await description.arrayBuffer()
    await f.run(async () =>
      expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(1),
    )
  } finally {
    await proxy.stop(true)
  }
})

test("control locators rebuild across a page without collapsing historical controls into current root state", async () => {
  await using f = await continuationFixture()
  using c = await continued(f)
  await f.run(() => Index.controlMigration.up(() => {}))
  const selected: Array<{ continuation: Execution.Continuation; grantID: string }> = []
  for (let version = 0; version < 130; version++) {
    const continuation = await c.control("control-" + version, version)
    const request = await inspect(f, { connectionEpoch: 2, continuation, grantID: undefined, generation: undefined })
    const proof = description(request.proof)
    const created = await f.run(async () =>
      c.execution.describe({ proof, signature: await Execution.signDescription(proof, f.machineKeys.privateKey) }),
    )
    if (version === 0 || version === 64 || version === 129)
      selected.push({ continuation, grantID: created.grant.grantID })
  }
  await f.run(async () => {
    await Storage.removeTree(["organization", "execution-control-grants"])
    await Storage.remove(["organization", "execution-control-index-schema"])
    let completed: [number, number] | undefined
    await Index.controlMigration.up((done, total) => {
      completed = [done, total]
    })
    expect(completed).toEqual([131, 131])
    expect(await Storage.count({ prefix: ["organization", "execution-control-grants", f.sessionID, "1"] })).toBe(130)
    for (const item of selected) {
      const request = await inspect(f, {
        connectionEpoch: 2,
        continuation: item.continuation,
        grantID: undefined,
        generation: undefined,
      })
      expect(await c.execution.retention(request)).toMatchObject({ state: "known", grant: { grantID: item.grantID } })
    }
    const current = selected.at(-1)!
    const first = selected[0]!
    await Storage.write(
      [
        "organization",
        "execution-control-grants",
        f.sessionID,
        "1",
        first.continuation.receipt.accepted!.permit.admissionID,
      ],
      { version: 1, grantID: current.grantID },
    )
    await expect(
      c.execution.retention(
        await inspect(f, {
          connectionEpoch: 2,
          continuation: first.continuation,
          grantID: undefined,
          generation: undefined,
        }),
      ),
    ).rejects.toThrow()
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(1)
  })
}, 15_000)

test("control allocation and immutable locator roll back together and incomplete migration cannot report absence", async () => {
  await using f = await continuationFixture()
  using c = await continued(f)
  const control = await c.control("rollback-control", 0)
  const inspection = await inspect(f, {
    connectionEpoch: 2,
    continuation: control,
    grantID: undefined,
    generation: undefined,
  })
  const proof = description(inspection.proof)
  await f.run(async () => {
    await Index.controlMigration.up(() => {})
    const write = Storage.write
    const failure = spyOn(Storage, "write").mockImplementation(async (key, value) => {
      await write(key, value)
      if (key[1] === "execution-control-grants") throw new Error("Fail after the native locator write")
    })
    try {
      await expect(
        c.execution.describe({ proof, signature: await Execution.signDescription(proof, f.machineKeys.privateKey) }),
      ).rejects.toThrow("native locator")
    } finally {
      failure.mockRestore()
    }
    expect(await c.execution.retention(inspection)).toMatchObject({ state: "absent" })
    expect(await Record.read(Record.ExecutionGrant, Keys.executionGrant(f.grant.grantID))).toMatchObject({
      retention: { state: "held", generation: 1 },
    })
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(1)
    const created = await c.execution.describe({
      proof,
      signature: await Execution.signDescription(proof, f.machineKeys.privateKey),
    })
    const grant = created.grant
    if (!grant.provenance) throw new Error("Expected canonical continuation provenance")
    await Storage.write(Keys.executionGrant(grant.grantID), {
      ...grant,
      provenance: {
        ...grant.provenance,
        control: { ...grant.provenance.control, permit: { ...grant.provenance.control.permit, bindingEpoch: 2 } },
      },
    })
    await expect(Index.controlMigration.up(() => {})).rejects.toThrow("canonical grant ownership")
    await expect(c.execution.retention(inspection)).rejects.toThrow("owning migration")
    await Storage.write(Keys.executionGrant(grant.grantID), grant)
    await Index.controlMigration.up(() => {})
    expect(await c.execution.retention(inspection)).toMatchObject({ state: "known", grant: { grantID: grant.grantID } })
  })
})

test.each(["describe", "bind"] as const)(
  "a delayed %s cannot allocate after its original signed commit window closes",
  async (operation) => {
    await using f = await continuationFixture()
    using c = await continued(f)
    await f.run(() => Index.controlMigration.up(() => {}))
    const control = await c.control("delayed-allocation", 0)
    const request = await inspect(f, {
      connectionEpoch: 2,
      continuation: control,
      grantID: undefined,
      generation: undefined,
    })
    const describe = description(request.proof)
    describe.expiresAt = describe.issuedAt + 500
    const binding = Execution.BindingProof.parse({
      ...f.binding.proof,
      connectionEpoch: 2,
      continuation: control,
      issuedAt: describe.issuedAt,
      expiresAt: describe.expiresAt,
    })
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const verifyDescription = Execution.verifyDescription
    const verifyBinding = Execution.verifyBinding
    const verification =
      operation === "describe"
        ? spyOn(Execution, "verifyDescription").mockImplementationOnce(async (...args) => {
            const valid = await verifyDescription(...args)
            entered.resolve()
            await resume.promise
            return valid
          })
        : spyOn(Execution, "verifyBinding").mockImplementationOnce(async (...args) => {
            const valid = await verifyBinding(...args)
            entered.resolve()
            await resume.promise
            return valid
          })
    const work = Promise.resolve(
      f.run(async () =>
        operation === "describe"
          ? c.execution.describe({
              proof: describe,
              signature: await Execution.signDescription(describe, f.machineKeys.privateKey),
            })
          : c.execution.bind({
              proof: binding,
              signature: await Execution.signBinding(binding, f.machineKeys.privateKey),
            }),
      ),
    )
    void work.catch(() => {})
    try {
      await entered.promise
      expect(await f.run(() => c.execution.retention(request))).toMatchObject({ state: "absent" })
      const clock = spyOn(Date, "now").mockImplementation(() => describe.expiresAt + 1)
      try {
        resume.resolve()
        await expect(work).rejects.toThrow("validity window")
      } finally {
        clock.mockRestore()
      }
      const refreshed = await inspect(f, {
        connectionEpoch: 2,
        continuation: control,
        grantID: undefined,
        generation: undefined,
      })
      expect(await f.run(() => c.execution.retention(refreshed))).toMatchObject({ state: "absent" })
      expect(
        (await f.run(() => Record.read(Record.SessionDirectory, Keys.session(f.sessionID))))!.retainedExecutionGrants,
      ).toBe(1)
    } finally {
      resume.resolve()
      verification.mockRestore()
      await work.catch(() => {})
    }
  },
)
