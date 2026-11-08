import { expect, spyOn, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationCommandProtocol as Command,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { commandFixture } from "./support/commands"
import { createCommandForwarder } from "../src/command-forwarding"
import { organizationOpenApi } from "../src/http"

function accepted(permit: Command.Permit): Command.Result {
  return Command.Result.parse({
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
      intakeSeq: permit.commandSeq,
      effect: {
        kind: "inbox",
        itemID: `item-${permit.commandSeq}`,
        messageID: `message-${permit.commandSeq}`,
        mode: "context",
      },
    },
  })
}
function answer(socket: WebSocket, frame: Extract<Runtime.ServerFrame, { type: "command" }>, result: Command.Result) {
  socket.send(
    JSON.stringify({
      type: "receipt",
      connectionEpoch: frame.connectionEpoch,
      exchangeID: frame.exchangeID,
      reply: { kind: "result", result },
    }),
  )
}

test("online forwarding awaits B and an explicit retry reconciles a lost receipt without another input", async () => {
  await using f = await commandFixture()
  const socket = await f.connect()
  const forwarder = createCommandForwarder({ admissions: f.commands, connections: f.connections, timeoutMs: 150 })
  const inputs: Command.InputDelivery[] = []
  let saved: Command.Result | undefined
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command") return
    const command = frame.command
    if (command.kind === "input") {
      inputs.push(command.delivery)
      const permit = command.delivery.authorization.permit
      saved = Command.Result.parse({
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
          intakeSeq: 1,
          effect: { kind: "inbox", itemID: "item", messageID: "message", mode: "context" },
        },
      })
      return
    }
    if (command.kind === "query")
      socket.send(
        JSON.stringify({
          type: "receipt",
          connectionEpoch: 1,
          exchangeID: frame.exchangeID,
          reply: { kind: "query", query: { authorization: command.authorization, result: saved } },
        }),
      )
  }
  await f.run(async () => {
    await expect(forwarder.input(f.credentials.alice, f.request())).rejects.toMatchObject({
      data: { code: "COMMAND_OUTCOME_UNKNOWN", requestID: "request", outcome: "unknown" },
    })
    expect(
      (await f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" })).attempt.state,
    ).toBe("unknown")
    const result = await forwarder.input(f.credentials.alice, f.request())
    expect(result).toMatchObject({ existing: true, receipt: saved!.accepted })
    expect(inputs).toHaveLength(1)
    await expect(forwarder.input(f.credentials.alice, f.request("request", "Changed"))).rejects.toMatchObject({
      data: { code: "REVISION_CONFLICT" },
    })
    expect(inputs).toHaveLength(1)
  })
})

test("native dropped sends are definitely unsent while send exceptions retain uncertainty", async () => {
  for (const outcome of ["drop", "throw"] as const) {
    await using f = await commandFixture({ timeoutMs: 150 })
    await f.connect()
    const send = spyOn(f.wire(), "send").mockImplementation(() => {
      if (outcome === "throw") throw new Error("native send interrupted")
      return 0
    })
    try {
      await f.run(async () => {
        await expect(f.forwarder.input(f.credentials.alice, f.request())).rejects.toMatchObject({
          data: {
            code: outcome === "drop" ? "RUNTIME_OFFLINE" : "COMMAND_OUTCOME_UNKNOWN",
            requestID: "request",
            outcome: outcome === "drop" ? "not_dispatched" : "unknown",
          },
        })
        const stored = await f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" })
        expect(stored.attempt.state).toBe(outcome === "drop" ? "not_dispatched" : "unknown")
        expect(stored.accepted).toBeUndefined()
        expect(send).toHaveBeenCalledTimes(1)
      })
    } finally {
      send.mockRestore()
    }
    f.connections.close()
    await f.run(async () => {
      await expect(f.forwarder.input(f.credentials.alice, f.request())).rejects.toMatchObject({
        data: { code: outcome === "drop" ? "RUNTIME_OFFLINE" : "COMMAND_OUTCOME_UNKNOWN", requestID: "request" },
      })
    })
  }
})

test("an enqueued backpressured frame is sent once and late accepted receipts survive caller timeout", async () => {
  await using f = await commandFixture({ timeoutMs: 100 })
  const socket = await f.connect()
  let sent: Extract<Runtime.ServerFrame, { type: "command" }> | undefined
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type === "command") sent = frame
  }
  const original = f.wire().send.bind(f.wire())
  const send = spyOn(f.wire(), "send").mockImplementation((data, compress) => {
    original(data, compress)
    return -1
  })
  await f.run(async () => {
    try {
      await expect(f.forwarder.input(f.credentials.alice, f.request())).rejects.toMatchObject({
        data: { code: "COMMAND_OUTCOME_UNKNOWN" },
      })
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      send.mockRestore()
    }
    if (!sent || sent.command.kind !== "input") throw new Error("Input frame was not delivered")
    const result = accepted(sent.command.delivery.authorization.permit)
    answer(socket, sent, result)
    let current = await f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" })
    for (let i = 0; !current.accepted && i < 100; i++) {
      await Bun.sleep(5)
      current = await f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" })
    }
    expect(current.accepted).toEqual(result.accepted)
    expect(await f.forwarder.input(f.credentials.alice, f.request())).toMatchObject({
      existing: true,
      receipt: result.accepted,
    })
  })
})

test("cancelling a queued request never admits it or cancels the active command", async () => {
  await using f = await commandFixture({ timeoutMs: 1000 })
  const socket = await f.connect()
  const received = Promise.withResolvers<Extract<Runtime.ServerFrame, { type: "command" }>>()
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type === "command") received.resolve(frame)
  }
  await f.run(async () => {
    const first = f.forwarder.input(f.credentials.alice, f.request())
    const frame = await received.promise
    const controller = new AbortController()
    const second = f.forwarder.input(f.credentials.alice, f.request("queued"), controller.signal)
    controller.abort()
    await expect(second).rejects.toMatchObject({ data: { outcome: "not_dispatched", requestID: "queued" } })
    expect(await Storage.count({ prefix: ["organization", "command-attempts"] })).toBe(1)
    if (frame.command.kind !== "input") throw new Error("Expected input")
    answer(socket, frame, accepted(frame.command.delivery.authorization.permit))
    expect(await first).toMatchObject({ existing: false })
    await expect(
      f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "queued" }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
  })
})

test("command OpenAPI declares required input and separates B acceptance from unknown delivery", async () => {
  const spec = await organizationOpenApi()
  const post = spec.paths?.["/org/v1/sessions/{sessionID}/commands"]?.post
  expect(post?.operationId).toBe("orgCommands.input")
  expect(post?.requestBody).toMatchObject({ required: true })
  expect(Object.keys(post?.responses ?? {})).toEqual(expect.arrayContaining(["200", "202", "409", "503", "504"]))
  expect(spec.paths?.["/org/v1/sessions/{sessionID}/commands/{requestID}"]?.get?.operationId).toBe("orgCommands.get")
})

test("a correlated receipt for another attempt cannot settle the dispatched request", async () => {
  await using f = await commandFixture({ timeoutMs: 1000 })
  const socket = await f.connect()
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command" || frame.command.kind !== "input") return
    const result = accepted({ ...frame.command.delivery.authorization.permit, attemptID: "another-attempt" })
    answer(socket, frame, result)
  }
  await f.run(async () => {
    await expect(f.forwarder.input(f.credentials.alice, f.request())).rejects.toMatchObject({
      data: { code: "COMMAND_OUTCOME_UNKNOWN" },
    })
    const record = await f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" })
    expect(record.attempt.state).toBe("unknown")
    expect(record.attempt.result).toBeUndefined()
    expect(record.accepted).toBeUndefined()
    expect(() => f.connections.capture("runtime-alice")).toThrow()
  })
})
