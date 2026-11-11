import { expect, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { commandFixture } from "./support/commands"
import { connection, keys } from "./support/runtime"
import { createHandoffs, registerHandoffAuthorityHistory } from "../src/handoff"
import { OrganizationAuthorityHistory } from "../src/authority-history"
import { OrganizationSharing } from "../src/sharing"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"

async function fixture(options: { sourceHandoffs?: boolean; targetHandoffs?: boolean; prepare?: boolean } = {}) {
  const f = await commandFixture()
  const sourceSocket = await f.connect(1, true, false, false, options.sourceHandoffs ?? true)
  const targetKeys = await keys()
  const target = await f.run(async () => {
    const current = (await Record.read(Record.RuntimeRegistration, Keys.runtime("runtime-bob")))!
    const updated = Record.RuntimeRegistration.parse({
      ...current,
      connectionEpoch: 0,
      publicKey: targetKeys.publicKey,
    })
    await Storage.write(Keys.runtime("runtime-bob"), updated)
    return updated
  })
  const socket = new WebSocket(f.baseUrl.replace(/^http/, "ws"))
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = reject
  })
  const signed = await connection(target, targetKeys.privateKey, 1)
  signed.proof.handshake.capabilities.push("commands")
  signed.proof.handshake.schemas.commands = 1
  if (options.targetHandoffs ?? true) {
    signed.proof.handshake.capabilities.push("handoffs")
    signed.proof.handshake.schemas.handoffs = 1
  }
  signed.signature = await Runtime.sign(signed.proof, targetKeys.privateKey)
  const connected = Promise.withResolvers<unknown>()
  socket.onmessage = (event) => connected.resolve(JSON.parse(String(event.data)))
  socket.send(JSON.stringify(signed))
  Runtime.Connected.parse(await connected.promise)
  await f.run(async () => {
    OrganizationAuthorityHistory.register()
    registerHandoffAuthorityHistory()
    await OrganizationAuthorityHistory.initialize({
      schemaVersion: 1,
      orgID: "org",
      deploymentIncarnation: "deployment",
      createdAt: 1,
    })
    await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
  })
  const handoffs = createHandoffs({ connections: f.connections, signing: f.signing, timeoutMs: 2000 })
  if (options.prepare ?? true)
    await f.run(() =>
      handoffs.prepare(f.credentials.alice, f.sessionID, {
        handoffID: "machine-handoff",
        targetRuntimeID: target.runtimeID,
        expectedBindingEpoch: 1,
        expectedControlRevision: 0,
        mappingPlanRevision: 1,
      }),
    )
  return {
    ...f,
    handoffs,
    sourceSocket,
    async [Symbol.asyncDispose]() {
      socket.close()
      await f[Symbol.asyncDispose]()
    },
  }
}

test("handoff preparation never locks a Session or consumes an epoch when either connected participant lacks its controller", async () => {
  for (const role of ["source", "target"] as const) {
    await using f = await fixture({
      sourceHandoffs: role !== "source",
      targetHandoffs: role !== "target",
      prepare: false,
    })
    await f.run(async () => {
      const before = await Record.read(Record.SessionDirectory, Keys.session(f.sessionID))
      await expect(
        f.handoffs.prepare(f.credentials.alice, f.sessionID, {
          handoffID: "unsupported-machine",
          targetRuntimeID: "runtime-bob",
          expectedBindingEpoch: 1,
          expectedControlRevision: 0,
          mappingPlanRevision: 1,
        }),
      ).rejects.toMatchObject({ data: { code: "PROTOCOL_MISMATCH" } })
      expect(await Record.read(Record.SessionDirectory, Keys.session(f.sessionID))).toEqual(before)
      await expect(f.handoffs.get(f.credentials.alice, "unsupported-machine")).rejects.toMatchObject({
        data: { code: "NOT_FOUND" },
      })
    })
  }
})

test("machine handoff dispatch uses current consent, canonical ownership and a signed finite WSS plan without allocating an input", async () => {
  await using f = await fixture()
  let calls = 0
  let captured: Handoff.MachinePlan | undefined
  f.sourceSocket.onmessage = async (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command" || frame.command.kind !== "handoff") return
    calls++
    const authorization = frame.command.authorization
    captured = authorization.plan
    expect(
      await Handoff.verifyMachinePlan(authorization.plan, authorization.signature, f.signing.identity.publicKey),
    ).toBe(true)
    f.sourceSocket.send(
      JSON.stringify({
        type: "receipt",
        connectionEpoch: 1,
        exchangeID: frame.exchangeID,
        reply: {
          kind: "handoff",
          authorization,
          result: {
            handoffID: captured.handoffID,
            requestID: captured.requestID,
            runtimeID: captured.runtimeID,
            operation: captured.operation,
            state: "working",
            stage: "preparing",
            revision: "a".repeat(64),
            requirements: [],
            facts: [],
          },
        },
      }),
    )
  }
  const request = { operation: "prepare-source" as const, requestID: "explicit-source-prepare" }
  await f.run(async () => {
    await expect(
      f.handoffs.drive(f.credentials.bob, "machine-handoff", request, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    await expect(
      f.handoffs.drive(f.credentials.alice, "machine-handoff", request, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
    expect(calls).toBe(0)
    await f.handoffs.accept(f.credentials.bob, "machine-handoff", { mappingPlanRevision: 1 })
    const result = await f.handoffs.drive(f.credentials.alice, "machine-handoff", request, {
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ state: "working", stage: "preparing" })
    expect(captured).toMatchObject({
      handoffID: "machine-handoff",
      runtimeID: "runtime-alice",
      connectionEpoch: 1,
      commandSeq: 0,
      sourceBinding: {
        schemaVersion: 1,
        orgID: "org",
        projectID: "project",
        creatorID: "alice",
        driverRuntimeID: "runtime-alice",
        bindingEpoch: 1,
      },
    })
    expect(calls).toBe(1)
    expect(await Storage.readMany([Keys.commandState(f.sessionID)])).toEqual([undefined])
    expect(await Storage.query({ prefix: ["organization", "command-attempts"], limit: 1 })).toEqual([])
  })
})

test("an unknown machine result is inspected explicitly without replaying the original action", async () => {
  await using f = await fixture()
  const received = Promise.withResolvers<void>()
  const operations: string[] = []
  f.sourceSocket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command" || frame.command.kind !== "handoff") return
    const authorization = frame.command.authorization
    const plan = authorization.plan
    operations.push(plan.operation)
    if (plan.operation === "prepare-source") {
      received.resolve()
      return
    }
    f.sourceSocket.send(
      JSON.stringify({
        type: "receipt",
        connectionEpoch: 1,
        exchangeID: frame.exchangeID,
        reply: {
          kind: "handoff",
          authorization,
          result: {
            handoffID: plan.handoffID,
            requestID: plan.requestID,
            runtimeID: plan.runtimeID,
            operation: plan.operation,
            state: "working",
            stage: "preparing",
            revision: "a".repeat(64),
            requirements: [],
            facts: [],
          },
        },
      }),
    )
  }
  await f.run(() => f.handoffs.accept(f.credentials.bob, "machine-handoff", { mappingPlanRevision: 1 }))
  const controller = new AbortController()
  const pending = Promise.resolve(
    f.run(() =>
      f.handoffs.drive(
        f.credentials.alice,
        "machine-handoff",
        { operation: "prepare-source", requestID: "lost-response" },
        { signal: controller.signal },
      ),
    ),
  )
  void pending.catch(() => {})
  await received.promise
  controller.abort(new Error("The caller stopped observing its result"))
  await expect(pending).rejects.toMatchObject({ data: { code: "COMMAND_OUTCOME_UNKNOWN", outcome: "unknown" } })
  expect(operations).toEqual(["prepare-source"])
  await f.run(async () => {
    expect((await f.handoffs.get(f.credentials.alice, "machine-handoff")).phase).toBe("preparing")
    const status = await f.handoffs.drive(
      f.credentials.alice,
      "machine-handoff",
      { operation: "inspect-source", requestID: "inspect-unknown" },
      { signal: new AbortController().signal },
    )
    expect(status.state).toBe("working")
    expect(operations).toEqual(["prepare-source", "inspect-source"])
    expect(await Storage.readMany([Keys.commandState(f.sessionID)])).toEqual([undefined])
  })
})

test("machine results reauthorize the initiating account after the native response", async () => {
  await using f = await fixture()
  await f.run(() => f.handoffs.accept(f.credentials.bob, "machine-handoff", { mappingPlanRevision: 1 }))
  f.sourceSocket.onmessage = async (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command" || frame.command.kind !== "handoff") return
    const authorization = frame.command.authorization
    const plan = authorization.plan
    await f.run(async () => {
      const account = (await Record.read(Record.Account, Keys.account("alice")))!
      await Storage.write(Keys.account("alice"), { ...account, authRevision: account.authRevision + 1 })
    })
    f.sourceSocket.send(
      JSON.stringify({
        type: "receipt",
        connectionEpoch: 1,
        exchangeID: frame.exchangeID,
        reply: {
          kind: "handoff",
          authorization,
          result: {
            handoffID: plan.handoffID,
            requestID: plan.requestID,
            runtimeID: plan.runtimeID,
            operation: plan.operation,
            state: "working",
            stage: "preparing",
            revision: "a".repeat(64),
            requirements: [],
            facts: [],
          },
        },
      }),
    )
  }
  await expect(
    f.run(() =>
      f.handoffs.drive(
        f.credentials.alice,
        "machine-handoff",
        { operation: "prepare-source", requestID: "revoked-response" },
        { signal: new AbortController().signal },
      ),
    ),
  ).rejects.toMatchObject({ data: { code: "AUTHENTICATION_REQUIRED" } })
})
