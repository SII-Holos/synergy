import { expect, test } from "bun:test"
import {
  OrganizationCommandProtocol as Command,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
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
    connectionEpoch: epoch,
    signal: controller.signal,
  })
  const inputs: Command.InputDelivery[] = []
  const replies: Runtime.ClientFrame[] = []
  let pending = Promise.resolve()
  let dropInput = false
  let dropReply = false
  socket.onclose = () => controller.abort()
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command") return
    pending = pending.then(async () => {
      const command = frame.command
      if (command.kind === "input") {
        inputs.push(command.delivery)
        if (dropInput) return
      }
      const reply = await runtime.run(async (): Promise<Command.Reply> =>
        command.kind === "input"
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
      if (!(command.kind === "input" && dropReply)) socket.send(JSON.stringify(receipt))
    })
  }
  return {
    inputs,
    replies,
    socket,
    intake,
    loseInput(value = true) {
      dropInput = value
    },
    loseReply(value = true) {
      dropReply = value
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
  expect(retry.data).toEqual(read.data.accepted!)
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
