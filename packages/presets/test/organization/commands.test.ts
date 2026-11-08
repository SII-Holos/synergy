import { expect, spyOn, test } from "bun:test"
import {
  OrganizationCommandProtocol as Command,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { commandFixture } from "../../../organization/test/support/commands"
import { createCommandIntake } from "../../../organization-runtime/src/command-intake"
import { registerSessionSchema } from "../../../organization-runtime/src/session-schema"

const binding = {
  schemaVersion: 1 as const,
  orgID: "org",
  projectID: "project",
  creatorID: "alice",
  driverRuntimeID: "runtime-alice",
  bindingEpoch: 1,
}

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
  const resumed = await client.orgCommands.control(
    { sessionID: f.sessionID, orgCommandControlRequest: { ...changed, requestID: "new-continue" } },
    { throwOnError: true },
  )
  expect(resumed.response.status).toBe(202)
  expect(resumed.data.effect).toMatchObject({ operation: "continue", controlVersion: 3 })
  await runtime.run(async () => {
    expect((await Session.get(f.sessionID)).paused).toBeUndefined()
    expect((await Session.get(f.sessionID)).resume?.actor).toEqual(resumed.data.permit.actor)
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
  const input = await client.orgCommands.input(
    {
      sessionID: retry.data.effect.sessionID,
      orgCommandInputRequest: { ...f.request("after-create"), sessionID: retry.data.effect.sessionID },
    },
    { throwOnError: true },
  )
  expect(input.data.intakeSeq).toBe(2)
  expect(input.data.permit.commandSeq).toBe(3)
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
      const reply = await runtime.run(async (): Promise<Command.Reply> =>
        command.kind === "create"
          ? { kind: "result", result: await intake.create(command.delivery) }
          : command.kind === "control"
            ? { kind: "result", result: await intake.control(command.delivery) }
            : command.kind === "input"
              ? { kind: "result", result: await intake.input(command.delivery) }
              : command.kind === "skip"
                ? { kind: "result", result: await intake.skip(command.authorization) }
                : { kind: "query", query: await intake.query(command.authorization) },
      )
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
