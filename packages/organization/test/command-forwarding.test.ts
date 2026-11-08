import { expect, spyOn, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationCommandProtocol as Command,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { commandFixture } from "./support/commands"
import { createCommandForwarder } from "../src/command-forwarding"
import { organizationOpenApi } from "../src/http"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationRecord as Record } from "../src/storage/records"

test("concurrent submissions retain their Session lock until each receipt settles", async () => {
  await using f = await commandFixture({ timeoutMs: 2_000 })
  const socket = await f.connect()
  const first = Promise.withResolvers<Extract<Runtime.ServerFrame, { type: "command" }>>()
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command" || frame.command.kind !== "input") return
    if (frame.command.delivery.authorization.permit.requestID === "request") first.resolve(frame)
    else answer(socket, frame, accepted(frame.command.delivery.authorization.permit))
  }
  await f.run(async () => {
    const one = f.forwarder.input(f.credentials.alice, f.request())
    const frame = await first.promise
    const two = f.forwarder.input(f.credentials.alice, f.request("second"))
    void two.catch(() => {})
    const timer = setTimeout(() => {
      if (frame.command.kind === "input") answer(socket, frame, accepted(frame.command.delivery.authorization.permit))
    }, 50)
    try {
      expect((await one).receipt.permit.commandSeq).toBe(1)
      expect((await two).receipt.permit.commandSeq).toBe(2)
    } finally {
      clearTimeout(timer)
      await Promise.allSettled([one, two])
    }
  })
})

test("receipt queries retain transport capacity behind a full command window", async () => {
  await using f = await commandFixture()
  const socket = await f.connect()
  let respond = true
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command" || frame.command.kind !== "query" || !respond) return
    socket.send(
      JSON.stringify({
        type: "receipt",
        connectionEpoch: frame.connectionEpoch,
        exchangeID: frame.exchangeID,
        reply: { kind: "query", query: { authorization: frame.command.authorization } },
      }),
    )
  }
  await f.run(async () => {
    const prepared = await f.commands.input(f.credentials.alice, f.request())
    if (prepared.kind !== "admitted") throw new Error("Expected a new admission")
    const controller = new AbortController()
    const work = { signal: controller.signal, deadline: Date.now() + 3_000 }
    const pending: Promise<Command.Reply>[] = []
    const send = (command: Command.Delivery) => prepared.connection.exchange(command, work)
    try {
      for (let index = 0; index < 16; index++) {
        const request = send({ kind: "input", delivery: prepared.delivery })
        void request.catch(() => {})
        pending.push(request)
      }
      expect(() => send({ kind: "input", delivery: prepared.delivery })).toThrow("busy")
      const query: Command.Delivery = { kind: "query", authorization: prepared.delivery.authorization }
      expect(await send(query)).toMatchObject({ kind: "query" })
      respond = false
      for (let index = 0; index < 16; index++) {
        const request = send(query)
        void request.catch(() => {})
        pending.push(request)
      }
      expect(() => send(query)).toThrow("busy")
    } finally {
      controller.abort()
      await Promise.allSettled(pending)
    }
  })
})

function controlReceipt(permit: Command.Permit): Command.Result {
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
      effect:
        permit.operation === "cancel"
          ? {
              kind: "control",
              operation: "cancel",
              controlVersion: 1,
              runID: "task-root",
              runStatusAtReception: "running",
            }
          : { kind: "control", operation: "pause", controlVersion: 2, pausedSince: Date.now(), changed: true },
    },
  })
}
function execution(): Command.ExecutionObservation {
  return {
    state: "observed",
    runID: "task-root",
    controlVersion: 1,
    activity: {
      observedAt: Date.now(),
      run: { id: "task-root", status: "running", recording: "partial", active: true },
      runsObserved: 1,
      activeExecutions: 1,
      processes: { active: 1, exited: 0, unknown: 1 },
      scope: "recorded_subtree",
      truncated: false,
    },
  }
}
function queryAnswer(
  socket: WebSocket,
  frame: Extract<Runtime.ServerFrame, { type: "command" }>,
  result: Command.Result,
) {
  if (frame.command.kind !== "query") throw new Error("Expected a query")
  socket.send(
    JSON.stringify({
      type: "receipt",
      connectionEpoch: frame.connectionEpoch,
      exchangeID: frame.exchangeID,
      reply: { kind: "query", query: { authorization: frame.command.authorization, result, execution: execution() } },
    }),
  )
}

test("cancel queries observe execution beside immutable receipts while a newer control waits", async () => {
  await using f = await commandFixture({ timeoutMs: 1_000 })
  const socket = await f.connect()
  const held = Promise.withResolvers<Extract<Runtime.ServerFrame, { type: "command" }>>()
  let saved: Command.Result | undefined
  let queries = 0
  let silent = false
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command") return
    if (frame.command.kind === "control") {
      if (frame.command.delivery.control.operation === "pause") return held.resolve(frame)
      saved = controlReceipt(frame.command.delivery.authorization.permit)
      return answer(socket, frame, saved)
    }
    if (frame.command.kind === "query") {
      queries++
      if (!silent) queryAnswer(socket, frame, saved!)
    }
  }
  await f.run(async () => {
    const { input: _, ...target } = f.request()
    const receipt = await f.forwarder.control(f.credentials.alice, {
      ...target,
      control: { operation: "cancel", runID: "task-root", controlVersion: 0 },
    })
    const pending = f.forwarder.control(f.credentials.alice, {
      ...target,
      requestID: "later-pause",
      control: { operation: "pause" },
    })
    void pending.catch(() => {})
    const frame = await held.promise
    try {
      const read = await f.forwarder.get(f.credentials.alice, { requestID: target.requestID })
      expect(read.accepted).toEqual(receipt.receipt)
      expect(read.execution).toMatchObject({
        state: "observed",
        activity: { activeExecutions: 1, processes: { active: 1, unknown: 1 } },
      })
      expect(queries).toBe(1)
    } finally {
      if (frame.command.kind === "control")
        answer(socket, frame, controlReceipt(frame.command.delivery.authorization.permit))
      await pending
    }
    silent = true
    const short = createCommandForwarder({ admissions: f.commands, connections: f.connections, timeoutMs: 50 })
    expect(await short.get(f.credentials.alice, { requestID: target.requestID })).toMatchObject({
      accepted: receipt.receipt,
      execution: { state: "unavailable", reason: "query_failed", runID: "task-root" },
    })
    f.connections.close()
    expect(await f.forwarder.get(f.credentials.alice, { requestID: target.requestID })).toMatchObject({
      accepted: receipt.receipt,
      execution: { state: "unavailable", reason: "runtime_offline", runID: "task-root" },
    })
    const persisted = await f.commands.get(f.credentials.alice, { requestID: target.requestID })
    expect(persisted.accepted).toEqual(receipt.receipt)
    expect(persisted.attempt.result).not.toHaveProperty("execution")
  })
})

test("a live observation rechecks current binding and read access after the Runtime replies", async () => {
  for (const change of ["binding", "permission"] as const) {
    await using f = await commandFixture({ timeoutMs: 1_000 })
    const socket = await f.connect()
    const requested = Promise.withResolvers<Extract<Runtime.ServerFrame, { type: "command" }>>()
    let saved: Command.Result | undefined
    socket.onmessage = (event) => {
      const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
      if (frame.type !== "command") return
      if (frame.command.kind === "control") {
        saved = controlReceipt(frame.command.delivery.authorization.permit)
        answer(socket, frame, saved)
      } else if (frame.command.kind === "query") requested.resolve(frame)
    }
    await f.run(async () => {
      const { input: _, ...target } = f.request()
      const receipt = await f.forwarder.control(f.credentials.alice, {
        ...target,
        control: { operation: "cancel", runID: "task-root", controlVersion: 0 },
      })
      const pending = f.forwarder.get(f.credentials.alice, { requestID: target.requestID })
      void pending.catch(() => {})
      const frame = await requested.promise
      if (change === "binding") {
        const current = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
        await Storage.write(Keys.session(f.sessionID), {
          ...current,
          bindingEpoch: current.bindingEpoch + 1,
          nextBindingEpoch: current.nextBindingEpoch + 1,
          rowRevision: current.rowRevision + 1,
        })
      } else await Storage.remove(Keys.projectMember("project", "alice"))
      queryAnswer(socket, frame, saved!)
      if (change === "binding")
        expect(await pending).toMatchObject({
          accepted: receipt.receipt,
          execution: { state: "unavailable", reason: "binding_changed" },
        })
      else await expect(pending).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
    })
  }
})

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

test("an explicit Runtime capacity refusal remains unsent and recovers through query and skip", async () => {
  await using f = await commandFixture({ timeoutMs: 1_000 })
  const socket = await f.connect()
  const exchanges: string[] = []
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command") return
    const command = frame.command
    exchanges.push(command.kind)
    if (command.kind === "input" && exchanges.length === 1) {
      socket.send(
        JSON.stringify({
          type: "receipt",
          connectionEpoch: frame.connectionEpoch,
          exchangeID: frame.exchangeID,
          reply: {
            kind: "error",
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "private queue metadata",
              outcome: "not_dispatched",
              retryable: true,
            },
          },
        }),
      )
    } else if (command.kind === "input") answer(socket, frame, accepted(command.delivery.authorization.permit))
    else if (command.kind === "query")
      socket.send(
        JSON.stringify({
          type: "receipt",
          connectionEpoch: frame.connectionEpoch,
          exchangeID: frame.exchangeID,
          reply: { kind: "query", query: { authorization: command.authorization } },
        }),
      )
    else if (command.kind === "skip")
      answer(socket, frame, {
        attempt: {
          schemaVersion: 1,
          permit: command.authorization.permit.command,
          receivedAt: Date.now(),
          status: "skipped",
        },
        skip: { schemaVersion: 1, permit: command.authorization.permit, receivedAt: Date.now() },
      })
  }
  await f.run(async () => {
    const error = await f.forwarder.input(f.credentials.alice, f.request()).catch((error: unknown) => error)
    expect(error).toMatchObject({
      data: { code: "SERVICE_UNAVAILABLE", outcome: "not_dispatched", requestID: "request", retryable: true },
    })
    expect(JSON.stringify(error)).not.toContain("private queue")
    const stored = await f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" })
    expect(stored.attempt.state).toBe("not_dispatched")
    expect(stored.accepted).toBeUndefined()
    expect((await f.forwarder.input(f.credentials.alice, f.request())).receipt.permit.commandSeq).toBe(2)
    expect(exchanges).toEqual(["input", "query", "skip", "input"])
  })
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
  expect(spec.paths?.["/org/v1/sessions"]?.post?.operationId).toBe("orgSessions.create")
  expect(spec.paths?.["/org/v1/commands/{requestID}"]?.get?.operationId).toBe("orgCommands.lookup")
  const control = spec.paths?.["/org/v1/sessions/{sessionID}/control"]?.post
  expect(control?.operationId).toBe("orgCommands.control")
  expect(control?.requestBody).toMatchObject({ required: true })
  expect(Object.keys(control?.responses ?? {})).toEqual(expect.arrayContaining(["200", "202", "409", "503", "504"]))
})

test("an unavailable receipt store retains the caller's request ID and internal failure cause", async () => {
  await using f = await commandFixture()
  const original = new Error("private storage failure")
  await f.run(async () => {
    const failed = spyOn(Storage, "readMany").mockRejectedValueOnce(original)
    try {
      await expect(f.forwarder.input(f.credentials.alice, f.request())).rejects.toMatchObject({
        data: { code: "COMMAND_OUTCOME_UNKNOWN", requestID: "request", outcome: "unknown" },
        cause: original,
      })
    } finally {
      failed.mockRestore()
    }
  })
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
