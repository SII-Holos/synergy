import { expect, spyOn, test } from "bun:test"
import {
  OrganizationCommandProtocol as Command,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationExecutionProtocol as Execution,
  OrganizationResourceProtocol as Resource,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { commandFixture } from "../../../organization/test/support/commands"
import { createCommandIntake } from "../../../organization-runtime/src/command-intake"
import { registerSessionSchema } from "../../../organization-runtime/src/session-schema"
import { OrganizationResources } from "../../../organization/src/resources"
import { OrganizationSessionResources } from "../../../organization/src/session-resources"

const binding = {
  schemaVersion: 1 as const,
  orgID: "org",
  projectID: "project",
  creatorID: "alice",
  driverRuntimeID: "runtime-alice",
  bindingEpoch: 1,
}

test("a lost command ACK prepares resources then binds the native root through machine HTTP without replaying input", async () => {
  await using home = await tmpdir()
  await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
  await using f = await commandFixture({ timeoutMs: 150 })
  const native = await nativeSession(runtime, f.sessionID)
  using wake = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
  await f.run(async () => {
    const resource = await OrganizationResources.create(
      f.credentials.admin,
      Resource.Create.parse({
        name: "Fixture model",
        scope: { kind: "organization" },
        credential: { kind: "bearer", value: "upstream-fixture-key" },
        configuration: {
          protocol: "openai-compatible",
          endpoint: "https://provider.example/v1",
          model: { id: "test", name: "Test", limit: { context: 8192, output: 1024 } },
        },
      }),
    )
    await OrganizationResources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "account", id: "alice" },
      { expectedRevision: 0, enabled: true },
    )
    await OrganizationSessionResources.set(f.credentials.alice, f.sessionID, {
      expectedRevision: 0,
      selection: {
        modelResourceID: resource.resourceID,
        connectionResourceIDs: [],
        infrastructure: { workspace: null, environment: null },
      },
    })
  })
  await using receiver = await peer(f, runtime)
  receiver.loseReply()
  const client = createOrganizationClient({ baseUrl: f.baseUrl, headers: f.apiHeaders() })
  const request = f.request("root-grant")
  request.input.mode = "task"
  expect(
    (await client.orgCommands.input({ sessionID: f.sessionID, orgCommandInputRequest: request })).response.status,
  ).toBe(504)
  const machine = createOrganizationClient({ baseUrl: f.baseUrl })
  const description = await runtime.run(() =>
    receiver.intake.descriptionProof({ subjectID: "alice", requestID: request.requestID }),
  )
  const resources = Execution.Description.parse(
    (
      await machine.orgExecution.resources(
        {
          orgExecutionDescriptionRequest: {
            proof: description,
            signature: await Execution.signDescription(description, f.machineKeys.privateKey),
          },
        },
        { throwOnError: true },
      )
    ).data,
  )
  expect(resources.grant.state).toBe("provisional")
  expect(resources.resources[0].definition).toMatchObject({ protocol: "openai-compatible", model: { id: "test" } })
  expect(JSON.stringify(resources)).not.toContain("provider.example")
  expect(JSON.stringify(resources)).not.toContain("upstream-fixture-key")
  const signed = await runtime.run(() =>
    ScopeContext.provide({
      scope: native.scope,
      workspace: null,
      fn: async () => {
        const item = (await SessionInbox.list(native.id))[0]!
        const rootID = item.messageID
        await expect(
          receiver.intake.bindingProof({ subjectID: "alice", requestID: request.requestID }, rootID),
        ).rejects.toMatchObject({ data: { code: "RESOURCE_UNAVAILABLE" } })
        await Session.update(native.id, (draft) => {
          draft.modelOverride = { providerID: "test", modelID: "test" }
        })
        expect((await SessionInbox.materializeNextTask(native.id)).status).toBe("materialized")
        await RolloutLedger.beginRun(RolloutLifecycle.owner(native), rootID)
        const proof = await receiver.intake.bindingProof({ subjectID: "alice", requestID: request.requestID }, rootID)
        return { proof, signature: await Execution.signBinding(proof, f.machineKeys.privateKey) }
      },
    }),
  )
  const response = await machine.orgExecution.bind({ orgExecutionBindingRequest: signed }, { throwOnError: true })
  expect(response.response.status).toBe(200)
  const bound = Execution.BoundGrant.parse(response.data)
  expect(bound.rootID).toBe(signed.proof.rootID)
  expect(
    (await client.orgCommands.get({ sessionID: f.sessionID, requestID: request.requestID }, { throwOnError: true }))
      .data.state,
  ).toBe("accepted")
  expect(receiver.inputs).toHaveLength(1)
  await runtime.run(async () => expect(await SessionInbox.list(native.id)).toHaveLength(0))
  await f.run(async () => {
    const records = await Storage.current().store.query({ prefix: ["organization", "execution-grants"] })
    expect(records).toHaveLength(1)
    expect(JSON.stringify(records.map((record) => record.value))).not.toContain(
      "Private input stays out of service storage",
    )
  })
  await receiver[Symbol.asyncDispose]()
  await runtime.close()
  await using restored = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
  await using reconnected = await peer(f, restored, 2)
  const currentProof = await restored.run(() =>
    reconnected.intake.bindingProof({ subjectID: "alice", requestID: request.requestID }, bound.rootID),
  )
  const current = await machine.orgExecution.bind(
    {
      orgExecutionBindingRequest: {
        proof: currentProof,
        signature: await Execution.signBinding(currentProof, f.machineKeys.privateKey),
      },
    },
    { throwOnError: true },
  )
  expect(current.data).toEqual(bound)
  expect(reconnected.inputs).toHaveLength(0)
})

test("HTTP control returns native facts, reconciles a lost ACK and refuses changed or stale Continue intent", async () => {
  await using home = await tmpdir()
  await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
  await using f = await commandFixture({ timeoutMs: 150 })
  await nativeSession(runtime, f.sessionID)
  using wake = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
  const client = createOrganizationClient({ baseUrl: f.baseUrl, headers: f.apiHeaders() })
  const { input: _input, ...offline } = f.request("offline-control")
  const unavailable = await client.orgCommands.control({
    sessionID: f.sessionID,
    orgCommandControlRequest: { ...offline, control: { operation: "continue", pausedSince: 1, controlVersion: 0 } },
  })
  expect(unavailable.response.status).toBe(503)
  expect(unavailable.error).toMatchObject({ requestID: "offline-control", outcome: "not_dispatched" })
  await using receiver = await peer(f, runtime)
  const input = f.request("saved-task")
  input.input.mode = "task"
  await client.orgCommands.input({ sessionID: f.sessionID, orgCommandInputRequest: input }, { throwOnError: true })
  const { input: _, ...target } = f.request("pause")
  const args = {
    sessionID: f.sessionID,
    orgCommandControlRequest: { ...target, control: { operation: "pause" as const } },
  }
  receiver.loseReply()
  const lost = await client.orgCommands.control(args)
  expect(lost.response.status).toBe(504)
  expect(lost.error).toMatchObject({ requestID: "pause", outcome: "unknown" })
  const observed = await client.orgCommands.get({ sessionID: f.sessionID, requestID: "pause" }, { throwOnError: true })
  const receipt = Command.ControlAccepted.parse(observed.data.accepted)
  expect(receipt.effect).toMatchObject({ operation: "pause", controlVersion: 1 })
  if (receipt.effect.operation !== "pause") throw new Error("Expected pause receipt")
  expect((await client.orgCommands.control(args, { throwOnError: true })).data).toEqual(receipt)
  receiver.loseReply(false)
  const again = await client.orgCommands.control(
    { ...args, orgCommandControlRequest: { ...args.orgCommandControlRequest, requestID: "new-pause" } },
    { throwOnError: true },
  )
  expect(again.response.status).toBe(200)
  expect(again.data.effect).toMatchObject({ operation: "pause", controlVersion: 2, changed: false })
  const continuation = {
    ...target,
    requestID: "old-continue",
    control: { operation: "continue" as const, pausedSince: receipt.effect.pausedSince, controlVersion: 1 },
  }
  expect(
    (await client.orgCommands.control({ sessionID: f.sessionID, orgCommandControlRequest: continuation })).response
      .status,
  ).toBe(409)
  expect(
    (
      await client.orgCommands.get(
        { sessionID: f.sessionID, requestID: continuation.requestID },
        { throwOnError: true },
      )
    ).data.result?.attempt,
  ).toMatchObject({ status: "rejected", reason: "CONTROL_CONFLICT" })
  const changed = { ...continuation, control: { ...continuation.control, controlVersion: 2 } }
  expect(
    (await client.orgCommands.control({ sessionID: f.sessionID, orgCommandControlRequest: changed })).response.status,
  ).toBe(409)
  const resumed = await (async () => {
    const request = { ...changed, requestID: "new-continue" }
    type Observed = { kind: "result"; value: Command.ControlResult } | { kind: "error"; error: unknown }
    const native = Promise.withResolvers<Observed>()
    const release = Promise.withResolvers<void>()
    const originalControl = receiver.intake.control
    using hold = spyOn(receiver.intake, "control").mockImplementation(async (delivery, received) => {
      if (delivery.authorization.permit.requestID !== request.requestID) return originalControl(delivery, received)
      try {
        const result = await originalControl(delivery, received)
        native.resolve({ kind: "result", value: result })
        await release.promise
        return result
      } catch (error) {
        native.resolve({ kind: "error", error })
        throw error
      }
    })
    const service = Promise.withResolvers<Observed>()
    const originalObserve = f.commands.observe
    using observe = spyOn(f.commands, "observe").mockImplementation(async (connection, value) => {
      if (value.attempt.permit.requestID !== request.requestID) return originalObserve(connection, value)
      try {
        const retained = await originalObserve(connection, value)
        service.resolve({ kind: "result", value: Command.ControlResult.parse(retained.result) })
        return retained
      } catch (error) {
        service.resolve({ kind: "error", error })
        throw error
      }
    })
    let response: Awaited<ReturnType<typeof client.orgCommands.control>>
    try {
      response = await client.orgCommands.control({ sessionID: f.sessionID, orgCommandControlRequest: request })
    } finally {
      release.resolve()
    }
    expect(response.response.status).toBe(504)
    expect(response).toMatchObject({
      error: {
        code: "COMMAND_OUTCOME_UNKNOWN",
        requestID: request.requestID,
        outcome: "unknown",
        retryable: false,
      },
    })
    const result = await native.promise
    if (result.kind === "error") throw result.error
    expect(result.value.attempt.status).toBe("accepted")
    const accepted = Command.ControlAccepted.parse(result.value.accepted)
    expect(accepted.permit).toEqual(result.value.attempt.permit)
    expect(accepted.permit).toMatchObject({
      orgID: request.orgID,
      sessionID: request.sessionID,
      projectID: request.projectID,
      runtimeID: request.runtimeID,
      requestID: request.requestID,
      bindingEpoch: binding.bindingEpoch,
      connectionEpoch: 1,
      operation: "continue",
      actor: { subjectID: binding.creatorID, requestID: request.requestID },
    })
    expect(accepted.permit.payloadHash).toBe(await Command.digestControl(request))
    expect(accepted.effect).toMatchObject({ operation: "continue", controlVersion: 3 })
    const retained = await service.promise
    if (retained.kind === "error") throw retained.error
    expect(retained.value).toEqual(result.value)
    const read = await client.orgCommands.get(
      { sessionID: f.sessionID, requestID: request.requestID },
      { throwOnError: true },
    )
    expect(read.data.state).toBe("accepted")
    expect(Command.ControlAccepted.parse(read.data.accepted)).toEqual(accepted)
    const deliveries = receiver.controls.filter(
      (delivery) => delivery.authorization.permit.requestID === request.requestID,
    )
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].authorization.permit).toEqual(accepted.permit)
    expect(
      await Command.verify(accepted.permit, deliveries[0].authorization.signature, f.signing.identity.publicKey),
    ).toBe(true)
    return accepted
  })()
  expect(resumed.effect).toMatchObject({ operation: "continue", controlVersion: 3 })
  await runtime.run(async () => {
    expect((await Session.get(f.sessionID)).paused).toBeUndefined()
    expect((await Session.get(f.sessionID)).resume?.actor).toEqual(resumed.permit.actor)
  })
  expect(receiver.controls).toHaveLength(4)
  receiver.loseSkipReply()
  const unclosed = await client.orgCommands.control({
    sessionID: f.sessionID,
    orgCommandControlRequest: { ...continuation, requestID: "lost-skip" },
  })
  expect(unclosed.response.status).toBe(504)
  expect(unclosed.error).toMatchObject({ requestID: "lost-skip", outcome: "unknown" })
  const closed = await client.orgCommands.get(
    { sessionID: f.sessionID, requestID: "lost-skip" },
    { throwOnError: true },
  )
  expect(closed.data.result?.attempt.status).toBe("rejected")
  expect(closed.data.result?.skip).toBeDefined()
  receiver.loseSkipReply(false)
  const later = await client.orgCommands.control(
    {
      sessionID: f.sessionID,
      orgCommandControlRequest: { ...target, requestID: "after-closure", control: { operation: "pause" } },
    },
    { throwOnError: true },
  )
  expect(later.data.effect.controlVersion).toBe(4)
  expect(receiver.controls).toHaveLength(6)
})

test("online creation reserves metadata and commits one native Session without exposing its title", async () => {
  await using home = await tmpdir()
  await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
  await using f = await commandFixture({ timeoutMs: 1000 })
  await using receiver = await peer(f, runtime)
  const request = {
    schemaVersion: 1,
    orgID: binding.orgID,
    requestID: "create-session",
    projectID: binding.projectID,
    runtimeID: binding.driverRuntimeID,
    creation: { operation: "create", title: "Private creation title" },
  }
  const response = await fetch(new URL("/org/v1/sessions", f.baseUrl), {
    method: "POST",
    headers: { ...f.apiHeaders(), "content-type": "application/json" },
    body: JSON.stringify(request),
  })
  expect(response.status).toBe(202)
  const receipt = Command.Accepted.parse(await response.json())
  expect(receipt.effect.kind).toBe("session")
  await runtime.run(async () => {
    const session = await Session.get(receipt.permit.sessionID)
    expect(session.organization).toEqual(binding)
    expect(session.title).toBe(request.creation.title)
    expect(session.workspaceID).toBeNull()
    expect(session.environmentID).toBeNull()
    expect(await SessionInbox.list(session.id)).toHaveLength(0)
  })
  await f.run(async () => {
    const rows = await Storage.current().store.query({ prefix: ["organization"] })
    expect(JSON.stringify(rows.map((row) => row.value))).not.toContain(request.creation.title)
  })
})

test("offline creation reserves nothing and a lost creation ACK recovers by request ID", async () => {
  await using home = await tmpdir()
  await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
  await using f = await commandFixture({ timeoutMs: 150 })
  const client = createOrganizationClient({ baseUrl: f.baseUrl, headers: f.apiHeaders() })
  const args = {
    orgCommandCreateRequest: {
      schemaVersion: 1 as const,
      orgID: binding.orgID,
      projectID: binding.projectID,
      runtimeID: binding.driverRuntimeID,
      requestID: "lost-create",
      creation: { operation: "create" as const, title: "Private retry title" },
    },
  }
  const offline = await client.orgSessions.create(args)
  expect(offline.response.status).toBe(503)
  expect(offline.error).toMatchObject({ outcome: "not_dispatched", requestID: "lost-create" })
  await f.run(async () => {
    expect(await Storage.count({ prefix: ["organization", "command-requests"] })).toBe(0)
    expect(await Storage.count({ prefix: ["organization", "sessions"] })).toBe(1)
  })
  await using receiver = await peer(f, runtime)
  receiver.loseReply()
  const lost = await client.orgSessions.create(args)
  expect(lost.response.status).toBe(504)
  expect(lost.error).toMatchObject({ requestID: "lost-create", outcome: "unknown" })
  const recovered = await client.orgCommands.lookup({ requestID: "lost-create" }, { throwOnError: true })
  expect(recovered.data.state).toBe("accepted")
  const receipt = Command.CreatedAccepted.parse(recovered.data.accepted)
  const retry = await client.orgSessions.create(args, { throwOnError: true })
  expect(retry.response.status).toBe(200)
  expect(retry.data).toEqual(receipt)
  expect(receiver.creations).toHaveLength(1)
  expect((await runtime.run(() => Session.get(receipt.effect.sessionID))).title).toBe("Private retry title")
  expect(
    (
      await client.orgSessions.create({
        orgCommandCreateRequest: {
          ...args.orgCommandCreateRequest,
          creation: { operation: "create", title: "Changed" },
        },
      })
    ).response.status,
  ).toBe(409)
  expect(
    (await client.orgCommands.lookup({ requestID: "lost-create" }, { headers: f.apiHeaders("owner") })).response.status,
  ).toBe(404)
})

test("unreceived creation can be skipped before the Session exists and retried with the same identity", async () => {
  await using home = await tmpdir()
  await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
  await using f = await commandFixture({ timeoutMs: 150 })
  await using receiver = await peer(f, runtime)
  receiver.loseInput()
  const client = createOrganizationClient({ baseUrl: f.baseUrl, headers: f.apiHeaders() })
  const args = {
    orgCommandCreateRequest: {
      schemaVersion: 1 as const,
      orgID: binding.orgID,
      projectID: binding.projectID,
      runtimeID: binding.driverRuntimeID,
      requestID: "unreceived-create",
      creation: { operation: "create" as const },
    },
  }
  expect((await client.orgSessions.create(args)).response.status).toBe(504)
  const first = receiver.creations[0]
  await runtime.run(async () => {
    await expect(Session.get(first.authorization.permit.sessionID)).rejects.toBeInstanceOf(Storage.NotFoundError)
  })
  receiver.loseInput(false)
  const retry = await client.orgSessions.create(args, { throwOnError: true })
  expect(retry.response.status).toBe(202)
  expect(retry.data.effect.sessionID).toBe(first.authorization.permit.sessionID)
  expect(retry.data.permit.commandSeq).toBe(2)
  expect(retry.data.intakeSeq).toBe(1)
  const delayed = await runtime.run(() => receiver.intake.create(first))
  expect(delayed.attempt.status).toBe("skipped")
  expect(delayed.accepted).toEqual(retry.data)
  const entered = Promise.withResolvers<Command.Result>()
  const release = Promise.withResolvers<void>()
  const observe = f.commands.observe
  const callbackState: { outcome?: Promise<{ kind: "settled" } | { kind: "failed"; error: unknown }> } = {}
  using originalReceipt = spyOn(f.commands, "observe").mockImplementation((...args) => {
    const operation = (async () => {
      const observed = await observe(...args)
      if (args[1].attempt.permit.requestID === "after-create") {
        entered.resolve(args[1])
        await release.promise
      }
      return observed
    })()
    if (args[1].attempt.permit.requestID === "after-create")
      callbackState.outcome = operation.then(
        () => ({ kind: "settled" as const }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      )
    return operation
  })
  const submitted = (async () => {
    const response = await client.orgCommands.input({
      sessionID: retry.data.effect.sessionID,
      orgCommandInputRequest: { ...f.request("after-create"), sessionID: retry.data.effect.sessionID },
    })
    if (response.data) return { data: Command.InputAccepted.parse(response.data) }
    expect(response.response.status).toBe(504)
    expect(response.error).toMatchObject({
      code: "COMMAND_OUTCOME_UNKNOWN",
      requestID: "after-create",
      outcome: "unknown",
    })
    const original = await entered.promise
    expect(original.attempt.status).toBe("accepted")
    const current = await client.orgCommands.get(
      { sessionID: retry.data.effect.sessionID, requestID: "after-create" },
      { throwOnError: true },
    )
    expect(current.data.state).toBe("accepted")
    expect(current.data.accepted).toEqual(original.accepted)
    return { data: Command.InputAccepted.parse(current.data.accepted) }
  })()
  const outcome = submitted.then(
    (value) => ({ kind: "returned" as const, value }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  )
  try {
    const committed = await Promise.race([
      entered.promise.then((result) => ({ kind: "committed" as const, result })),
      outcome,
    ])
    if (committed.kind === "failed") throw committed.error
    if (committed.kind !== "committed")
      throw new Error("The original input returned before the retained Service receipt was observed")
    expect(committed.result.attempt.status).toBe("accepted")
    expect(committed.result.accepted?.permit).toMatchObject({
      orgID: binding.orgID,
      runtimeID: binding.driverRuntimeID,
      sessionID: retry.data.effect.sessionID,
      requestID: "after-create",
      connectionEpoch: 1,
      bindingEpoch: 1,
    })
    const completed = await outcome
    if (completed.kind === "failed") throw completed.error
    expect(completed.value.data.intakeSeq).toBe(2)
    expect(completed.value.data.permit.commandSeq).toBe(3)
    expect(receiver.inputs.filter((value) => value.authorization.permit.requestID === "after-create")).toHaveLength(1)
  } finally {
    release.resolve()
    await Promise.all([outcome, callbackState.outcome?.then(() => undefined)])
  }
  const callback = await callbackState.outcome
  if (callback?.kind === "failed") throw callback.error
})

async function nativeSession(runtime: Awaited<ReturnType<typeof testRuntime>>, sessionID: string) {
  return runtime.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: binding.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    return ScopeContext.provide({
      scope,
      workspace: null,
      fn: () => Session.create({ id: sessionID, organization: binding, workspaceID: null }),
    })
  })
}

async function peer(
  f: Awaited<ReturnType<typeof commandFixture>>,
  runtime: Awaited<ReturnType<typeof testRuntime>>,
  epoch = 1,
) {
  const socket = await f.connect(epoch)
  const controller = new AbortController()
  const intake = createCommandIntake({
    identity: f.signing.identity,
    runtimeID: binding.driverRuntimeID,
    accountID: binding.creatorID,
    connectionEpoch: epoch,
    signal: controller.signal,
  })
  const inputs: Command.InputDelivery[] = []
  const creations: Command.CreateDelivery[] = []
  const controls: Command.ControlDelivery[] = []
  const replies: Runtime.ClientFrame[] = []
  let pending = Promise.resolve()
  let dropInput = false
  let dropReply = false
  let dropSkipReply = false
  socket.onclose = () => controller.abort()
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command") return
    pending = pending.then(async () => {
      const command = frame.command
      if (command.kind === "create") {
        creations.push(command.delivery)
        if (dropInput) return
      }
      if (command.kind === "input") {
        inputs.push(command.delivery)
        if (dropInput) return
      }
      if (command.kind === "control") {
        controls.push(command.delivery)
        if (dropInput) return
      }
      const reply = await runtime.run(async (): Promise<Command.Reply> => {
        switch (command.kind) {
          case "create":
            return { kind: "result", result: await intake.create(command.delivery) }
          case "control":
            return { kind: "result", result: await intake.control(command.delivery) }
          case "input":
            return { kind: "result", result: await intake.input(command.delivery) }
          case "decision":
            return { kind: "result", result: await intake.decision(command.delivery) }
          case "skip":
            return { kind: "result", result: await intake.skip(command.authorization) }
          case "query":
            return { kind: "query", query: await intake.query(command.authorization) }
          default:
            throw new Error(`Unsupported command in the native peer fixture: ${command.kind}`)
        }
      })
      const receipt: Runtime.ClientFrame = {
        type: "receipt",
        connectionEpoch: epoch,
        exchangeID: frame.exchangeID,
        reply,
      }
      replies.push(receipt)
      if (command.kind === "skip" && dropSkipReply) return
      if (!(["input", "create", "control"].includes(command.kind) && dropReply)) socket.send(JSON.stringify(receipt))
    })
  }
  return {
    inputs,
    creations,
    controls,
    replies,
    socket,
    intake,
    loseInput(value = true) {
      dropInput = value
    },
    loseReply(value = true) {
      dropReply = value
    },
    loseSkipReply(value = true) {
      dropSkipReply = value
    },
    async [Symbol.asyncDispose]() {
      controller.abort()
      socket.close()
      await pending
    },
  }
}

test("generated HTTP commands cross service A and native Inbox B with current authorization and no persisted body", async () => {
  await using home = await tmpdir()
  await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
  await using f = await commandFixture({ timeoutMs: 1000 })
  await nativeSession(runtime, f.sessionID)
  await using receiver = await peer(f, runtime)
  const client = createOrganizationClient({ baseUrl: f.baseUrl, headers: f.apiHeaders() })
  const args = { sessionID: f.sessionID, orgCommandInputRequest: f.request() }
  const first = await client.orgCommands.input(args, { throwOnError: true })
  expect(first.response.status).toBe(202)
  expect(first.data.effect.mode).toBe("context")
  expect(first.data.permit.actor.subjectID).toBe("alice")
  const duplicate = await client.orgCommands.input(args, { throwOnError: true })
  expect(duplicate.response.status).toBe(200)
  expect(duplicate.data).toEqual(first.data)
  const read = await client.orgCommands.get({ sessionID: f.sessionID, requestID: "request" }, { throwOnError: true })
  expect(read.data.state).toBe("accepted")
  expect(read.data.accepted).toEqual(first.data)
  expect(JSON.stringify(read.data)).not.toContain("signature")
  expect(receiver.inputs).toHaveLength(1)
  await runtime.run(async () => {
    const inbox = await SessionInbox.list(f.sessionID)
    expect(inbox).toHaveLength(1)
    expect(inbox[0].message?.actor).toEqual(first.data.permit.actor)
    expect(inbox[0].messageID).toBe(first.data.effect.messageID)
  })
  await f.run(async () => {
    const rows = await Storage.current().store.query({ prefix: ["organization"] })
    expect(JSON.stringify(rows.map((row) => row.value))).not.toContain(args.orgCommandInputRequest.input.parts[0].text)
  })
  const changed = await client.orgCommands.input({ ...args, orgCommandInputRequest: f.request("request", "changed") })
  expect(changed.response.status).toBe(409)
  const forbidden = await client.orgCommands.get(
    { sessionID: f.sessionID, requestID: "request" },
    { headers: f.apiHeaders("owner") },
  )
  expect(forbidden.response.status).toBe(404)
  const forged = await fetch(new URL(`/org/v1/sessions/${f.sessionID}/commands`, f.baseUrl), {
    method: "POST",
    headers: { ...f.apiHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ ...f.request(), actor: { subjectID: "secret-forged-actor" } }),
  })
  expect(forged.status).toBe(400)
  expect(await forged.text()).not.toContain("secret-forged-actor")
  const noCsrf = await client.orgCommands.input(args, { headers: { ...f.apiHeaders(), "x-csrf-token": "bad" } })
  expect(noCsrf.response.status).toBe(403)
})

test("lost B acknowledgment is 504 and reconnect queries the original durable effect without replay", async () => {
  await using home = await tmpdir()
  await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
  await using f = await commandFixture({ timeoutMs: 150 })
  await nativeSession(runtime, f.sessionID)
  await using first = await peer(f, runtime)
  first.loseReply()
  const client = createOrganizationClient({ baseUrl: f.baseUrl, headers: f.apiHeaders() })
  const args = { sessionID: f.sessionID, orgCommandInputRequest: f.request() }
  const lost = await client.orgCommands.input(args)
  expect(lost.response.status).toBe(504)
  expect(lost.error).toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN", outcome: "unknown", requestID: "request" })
  expect(first.inputs).toHaveLength(1)
  expect(await runtime.run(() => SessionInbox.list(f.sessionID))).toHaveLength(1)
  await using second = await peer(f, runtime, 2)
  const read = await client.orgCommands.get({ sessionID: f.sessionID, requestID: "request" }, { throwOnError: true })
  expect(read.data.state).toBe("accepted")
  const retry = await client.orgCommands.input(args, { throwOnError: true })
  expect(retry.response.status).toBe(200)
  expect(retry.data).toEqual(Command.InputAccepted.parse(read.data.accepted))
  expect(second.inputs).toHaveLength(0)
  expect(await runtime.run(() => SessionInbox.list(f.sessionID))).toHaveLength(1)
})

test("explicit retry queries absence, commits skip and fences the delayed original frame", async () => {
  await using home = await tmpdir()
  await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
  await using f = await commandFixture({ timeoutMs: 150 })
  await nativeSession(runtime, f.sessionID)
  await using receiver = await peer(f, runtime)
  receiver.loseInput()
  const client = createOrganizationClient({ baseUrl: f.baseUrl, headers: f.apiHeaders() })
  const args = { sessionID: f.sessionID, orgCommandInputRequest: f.request() }
  expect((await client.orgCommands.input(args)).response.status).toBe(504)
  const read = await client.orgCommands.get({ sessionID: f.sessionID, requestID: "request" }, { throwOnError: true })
  expect(read.data.state).toBe("not_dispatched")
  expect(await runtime.run(() => SessionInbox.list(f.sessionID))).toHaveLength(0)
  expect(receiver.replies.filter((frame) => frame.type === "receipt" && frame.reply.kind === "result")).toHaveLength(0)
  receiver.loseInput(false)
  const retry = await client.orgCommands.input(args, { throwOnError: true })
  expect(retry.response.status).toBe(202)
  expect(retry.data.permit.commandSeq).toBe(2)
  expect(receiver.inputs).toHaveLength(2)
  const late = await runtime.run(() => receiver.intake.input(receiver.inputs[0]))
  expect(late.attempt.status).toBe("skipped")
  expect(late.accepted).toEqual(retry.data)
  const next = await client.orgCommands.input(
    { ...args, orgCommandInputRequest: f.request("next") },
    { throwOnError: true },
  )
  expect(next.response.status).toBe(202)
  expect(next.data.intakeSeq).toBe(2)
  expect(await runtime.run(() => SessionInbox.list(f.sessionID))).toHaveLength(2)
})
