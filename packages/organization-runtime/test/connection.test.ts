import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  OrganizationRuntimeProtocol as Protocol,
  OrganizationCommandProtocol as Command,
} from "@ericsanchezok/synergy-organization-protocol"
import { fileLockPath, withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { openMemberConnection } from "../src/connection"
import { startMemberBridge } from "../src/bridge"
import { fixture } from "./support/organization"
import { OrganizationRuntimeError } from "../src/error"

async function enrolled() {
  const f = await fixture()
  try {
    const member = await prepareMemberHome({
      baseDirectory: path.join(f.root, "members"),
      identity: f.identity,
      origin: f.origin,
    })
    const registration = await enrollMemberRuntime({
      home: member.home,
      identity: member.identity,
      ca: f.ca,
      ticket: await f.ticket(member.identity.deviceID, member.publicKey),
    })
    const options = { home: member.home, identity: member.identity, ca: f.ca, buildVersion: "fixture-runtime" }
    return { ...f, member, registration, options }
  } catch (error) {
    try {
      await f[Symbol.asyncDispose]()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Member fixture setup failed")
    }
    throw error
  }
}

async function within<T>(promise: Promise<T>) {
  const expired = Promise.withResolvers<never>()
  const timer = setTimeout(() => expired.reject(new Error("Member bridge observation expired")), 3_000)
  try {
    return await Promise.race([promise, expired.promise])
  } finally {
    clearTimeout(timer)
  }
}

function commandAuthorization(
  f: Awaited<ReturnType<typeof enrolled>>,
  connection: Awaited<ReturnType<typeof openMemberConnection>>,
  requestID: string,
): Command.SignedPermit {
  return Command.SignedPermit.parse({
    signature: "0".repeat(128),
    permit: {
      schemaVersion: 1,
      purpose: "session-command",
      orgID: f.identity.orgID,
      deploymentIncarnation: connection.connected.deploymentIncarnation,
      keyID: connection.connected.signingIdentity.keyID,
      requestID,
      payloadHash: "0".repeat(64),
      sessionID: "session",
      projectID: "project",
      runtimeID: connection.connected.runtimeID,
      bindingEpoch: 1,
      connectionEpoch: connection.connected.connectionEpoch,
      commandSeq: 1,
      shareGeneration: 0,
      controlRevision: 0,
      authRevision: 1,
      admissionID: requestID,
      attemptID: requestID,
      operation: "input",
      actor: {
        kind: "account",
        orgID: f.identity.orgID,
        subjectID: f.identity.accountID,
        displayName: "Member",
        clientKind: "web",
        requestID,
      },
      authorizedAt: Date.now(),
      deadline: Date.now() + 30_000,
    },
  })
}

test("verified WSS keeps heartbeats and receipt queries live while a control drains", async () => {
  await using f = await enrolled()
  const remote = Promise.withResolvers<Parameters<NonNullable<Parameters<typeof f.interceptFrames>[0]>>[0]>()
  const responses = new Map<string, ReturnType<typeof Promise.withResolvers<Command.Reply>>>()
  const heartbeats = Promise.withResolvers<void>()
  let holding = false
  let receivedHeartbeats = 0
  let advertised = false
  f.interceptFrames((socket, raw) => {
    const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type === "handshake")
      advertised =
        frame.proof.handshake.capabilities.includes("commands") && frame.proof.handshake.schemas.commands === 1
    if (frame.type === "heartbeat") {
      remote.resolve(socket)
      if (holding && ++receivedHeartbeats >= 14) heartbeats.resolve()
    }
    if (frame.type !== "receipt") return false
    responses.get(frame.exchangeID)?.resolve(frame.reply)
    return true
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const queries: string[] = []
  let signal: AbortSignal | undefined
  let identity: Command.SigningIdentity | undefined
  await using connection = await openMemberConnection({
    ...f.options,
    commands(connected, currentSignal) {
      signal = currentSignal
      identity = connected.signingIdentity
      return {
        async create() {
          throw new Error("private creation storage details")
        },
        async control() {
          holding = true
          entered.resolve()
          await release.promise
          throw new Error("private control storage details")
        },
        async input() {
          throw new Error("private intake storage details")
        },
        async skip() {
          throw new OrganizationRuntimeError({
            code: "STALE_BINDING",
            message: "Binding changed",
            outcome: "rejected",
            retryable: false,
          })
        },
        async query(authorization) {
          queries.push(authorization.permit.requestID)
          return { authorization }
        },
      }
    },
  })
  using unblock = { [Symbol.dispose]: () => release.resolve() }
  expect(advertised).toBe(true)
  expect(identity).toEqual(connection.connected.signingIdentity)
  const socket = await within(remote.promise)
  const authorization = (requestID: string) => commandAuthorization(f, connection, requestID)
  function send(exchangeID: string, command: Command.Delivery) {
    const response = Promise.withResolvers<Command.Reply>()
    responses.set(exchangeID, response)
    socket.send(
      JSON.stringify({ type: "command", connectionEpoch: connection.connected.connectionEpoch, exchangeID, command }),
    )
    return response.promise
  }
  const blocked = authorization("first")
  blocked.permit.operation = "pause"
  const first = send("first", {
    kind: "control",
    delivery: { authorization: blocked, control: { operation: "pause" } },
  })
  await within(entered.promise)
  const second = send("second", { kind: "query", authorization: authorization("second") })
  expect((await within(second)).kind).toBe("query")
  await within(heartbeats.promise)
  expect(signal?.aborted).toBeFalse()
  release.resolve()
  expect(await within(first)).toMatchObject({
    kind: "error",
    error: { code: "SERVICE_UNAVAILABLE", outcome: "unknown" },
  })
  expect(queries).toEqual(["second"])
  const failed = await within(
    send("input", {
      kind: "input",
      delivery: {
        authorization: authorization("input"),
        input: { operation: "input", mode: "context", parts: [{ type: "text", text: "private input" }] },
      },
    }),
  )
  expect(failed).toMatchObject({ kind: "error", error: { code: "SERVICE_UNAVAILABLE", outcome: "unknown" } })
  expect(JSON.stringify(failed)).not.toContain("private")
  const pause = authorization("pause")
  pause.permit.operation = "pause"
  const controlled = await within(
    send("pause", { kind: "control", delivery: { authorization: pause, control: { operation: "pause" } } }),
  )
  expect(controlled).toMatchObject({ kind: "error", error: { code: "SERVICE_UNAVAILABLE", outcome: "unknown" } })
  expect(JSON.stringify(controlled)).not.toContain("private")
  const command = authorization("skip").permit
  const skipped = await within(
    send("skip", {
      kind: "skip",
      authorization: {
        permit: {
          schemaVersion: 1,
          purpose: "session-command-skip",
          command,
          connectionEpoch: connection.connected.connectionEpoch,
          authorizedAt: Date.now(),
          deadline: Date.now() + 30_000,
        },
        signature: "0".repeat(128),
      },
    }),
  )
  expect(skipped).toMatchObject({ kind: "error", error: { code: "STALE_BINDING", outcome: "rejected" } })
  await connection.close()
  expect(signal?.aborted).toBe(true)
})

test("the resident bridge reassembles ordered command chunks before delivery", async () => {
  await using f = await enrolled()
  const remote = Promise.withResolvers<Parameters<NonNullable<Parameters<typeof f.interceptFrames>[0]>>[0]>()
  const received = Promise.withResolvers<Command.InputDelivery>()
  f.interceptFrames((socket, raw) => {
    const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type === "heartbeat") remote.resolve(socket)
    return false
  })
  await using connection = await openMemberConnection({
    ...f.options,
    commands() {
      return {
        async create() {
          throw new Error("unavailable")
        },
        async control() {
          throw new Error("unavailable")
        },
        async skip() {
          throw new Error("unavailable")
        },
        async query(authorization) {
          return { authorization }
        },
        async input(delivery) {
          received.resolve(delivery)
          const permit = delivery.authorization.permit
          return {
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
              effect: { kind: "inbox", itemID: "item", messageID: "message", mode: delivery.input.mode },
            },
          }
        },
      }
    },
  })
  const socket = await within(remote.promise)
  const text = "chunked runtime input " + "x".repeat(220_000)
  const command: Command.Delivery = {
    kind: "input",
    delivery: {
      authorization: commandAuthorization(f, connection, "chunked"),
      input: { operation: "input", mode: "task", parts: [{ type: "text", text }] },
    },
  }
  const payload = new TextEncoder().encode(JSON.stringify(command))
  const chunkSize = 43 * 1024
  const total = Math.ceil(payload.byteLength / chunkSize)
  for (let index = 0; index < total; index++) {
    socket.send(
      JSON.stringify({
        type: "command-chunk",
        connectionEpoch: connection.connected.connectionEpoch,
        exchangeID: "chunked-exchange",
        index,
        total,
        data: Buffer.from(
          payload.subarray(index * chunkSize, Math.min(payload.byteLength, (index + 1) * chunkSize)),
        ).toString("base64url"),
      }),
    )
  }
  const delivery = await within(received.promise)
  expect(delivery.input.parts).toEqual([{ type: "text", text }])
})

test("a committed control receipt returns before drainage while close retains the callback", async () => {
  await using f = await enrolled()
  const remote = Promise.withResolvers<Parameters<NonNullable<Parameters<typeof f.interceptFrames>[0]>>[0]>()
  const received = Promise.withResolvers<Command.Reply>()
  const replies: Command.Reply[] = []
  const release = Promise.withResolvers<void>()
  let drained = false
  let signal: AbortSignal | undefined
  f.interceptFrames((socket, raw) => {
    const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type === "heartbeat") remote.resolve(socket)
    if (frame.type !== "receipt") return false
    replies.push(frame.reply)
    received.resolve(frame.reply)
    return true
  })
  await using connection = await openMemberConnection({
    ...f.options,
    commands(_connected, currentSignal) {
      signal = currentSignal
      return {
        async create() {
          throw new Error("unavailable")
        },
        async input() {
          throw new Error("unavailable")
        },
        async skip() {
          throw new Error("unavailable")
        },
        async query(authorization) {
          return { authorization }
        },
        async control(delivery, onReceipt) {
          const permit = delivery.authorization.permit
          const result = Command.ControlResult.parse({
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
              effect: { kind: "control", operation: "pause", controlVersion: 1, pausedSince: 1, changed: true },
            },
          })
          onReceipt?.(result)
          await release.promise
          drained = true
          throw new Error("private drainage failure after reception")
        },
      }
    },
  })
  using unblock = { [Symbol.dispose]: () => release.resolve() }
  const socket = await within(remote.promise)
  const authorization = commandAuthorization(f, connection, "early-receipt")
  authorization.permit.operation = "pause"
  socket.send(
    JSON.stringify({
      type: "command",
      connectionEpoch: connection.connected.connectionEpoch,
      exchangeID: "early-receipt",
      command: { kind: "control", delivery: { authorization, control: { operation: "pause" } } },
    }),
  )
  expect(await within(received.promise)).toMatchObject({
    kind: "result",
    result: { accepted: { permit: { requestID: "early-receipt" } } },
  })
  expect(drained).toBeFalse()
  expect(signal?.aborted).toBeFalse()
  let closed = false
  const closing = connection.close().then(() => {
    closed = true
  })
  await Bun.sleep(0)
  expect(signal?.aborted).toBeTrue()
  expect(closed).toBeFalse()
  release.resolve()
  await within(closing)
  expect(drained).toBeTrue()
  expect(replies).toHaveLength(1)
})

for (const limit of ["count", "bytes"] as const)
  test(`command ${limit} saturation retains reconciliation capacity and drains accepted callbacks`, async () => {
    await using f = await enrolled()
    const remote = Promise.withResolvers<Parameters<NonNullable<Parameters<typeof f.interceptFrames>[0]>>[0]>()
    const responses = new Map<string, ReturnType<typeof Promise.withResolvers<Command.Reply>>>()
    const entered = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
    const release = Promise.withResolvers<void>()
    const releaseClosing = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    let completed = 0
    let signal: AbortSignal | undefined
    f.interceptFrames((socket, raw) => {
      const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
      if (frame.type === "heartbeat") remote.resolve(socket)
      if (frame.type !== "receipt") return false
      responses.get(frame.exchangeID)?.resolve(frame.reply)
      return true
    })
    await using connection = await openMemberConnection({
      ...f.options,
      commands(_connected, currentSignal) {
        signal = currentSignal
        signal.addEventListener("abort", () => aborted.resolve(), { once: true })
        return {
          async create() {
            throw new Error("unavailable")
          },
          async control() {
            throw new Error("unavailable")
          },
          async skip() {
            throw new Error("unavailable")
          },
          async query(authorization) {
            return { authorization }
          },
          async input(delivery) {
            entered.get(delivery.authorization.permit.requestID)?.resolve()
            await (delivery.authorization.permit.requestID === "closing" ? releaseClosing.promise : release.promise)
            completed++
            throw new Error("private completion")
          },
        }
      },
    })
    using unblock = {
      [Symbol.dispose]() {
        release.resolve()
        releaseClosing.resolve()
      },
    }
    const socket = await within(remote.promise)
    let admitted = 0
    let bytes = 0
    for (let index = 0; index <= 16; index++) {
      const id = `held-${index}`
      const command: Command.Delivery = {
        kind: "input",
        delivery: {
          authorization: commandAuthorization(f, connection, id),
          input: {
            operation: "input",
            mode: "context",
            parts: [{ type: "text", text: limit === "bytes" ? "x".repeat(32_000) : "held" }],
          },
        },
      }
      const raw = JSON.stringify({
        type: "command",
        connectionEpoch: connection.connected.connectionEpoch,
        exchangeID: id,
        command,
      })
      const response = Promise.withResolvers<Command.Reply>()
      const started = Promise.withResolvers<void>()
      responses.set(id, response)
      entered.set(id, started)
      socket.send(raw)
      if (admitted === 16 || bytes + Buffer.byteLength(raw) > 256 * 1024) {
        expect(await within(response.promise)).toMatchObject({
          kind: "error",
          error: { code: "SERVICE_UNAVAILABLE", outcome: "not_dispatched", retryable: true },
        })
        break
      }
      await within(started.promise)
      admitted++
      bytes += Buffer.byteLength(raw)
    }
    if (limit === "count") expect(admitted).toBe(16)
    else {
      expect(admitted).toBeGreaterThan(0)
      expect(admitted).toBeLessThan(16)
      expect(bytes).toBeLessThanOrEqual(256 * 1024)
    }
    expect(completed).toBe(0)
    expect(signal?.aborted).toBeFalse()
    const probe = Promise.withResolvers<Command.Reply>()
    responses.set("probe", probe)
    socket.send(
      JSON.stringify({
        type: "command",
        connectionEpoch: connection.connected.connectionEpoch,
        exchangeID: "probe",
        command: { kind: "query", authorization: commandAuthorization(f, connection, "probe") },
      }),
    )
    expect((await within(probe.promise)).kind).toBe("query")
    release.resolve()
    await within(Promise.all(Array.from({ length: admitted }, (_, index) => responses.get(`held-${index}`)!.promise)))
    expect(completed).toBe(admitted)
    const closingEntered = Promise.withResolvers<void>()
    entered.set("closing", closingEntered)
    socket.send(
      JSON.stringify({
        type: "command",
        connectionEpoch: connection.connected.connectionEpoch,
        exchangeID: "closing",
        command: {
          kind: "input",
          delivery: {
            authorization: commandAuthorization(f, connection, "closing"),
            input: { operation: "input", mode: "context", parts: [{ type: "text", text: "close after refill" }] },
          },
        },
      }),
    )
    await within(closingEntered.promise)
    if (limit === "count") {
      socket.send(
        JSON.stringify({
          type: "command",
          connectionEpoch: connection.connected.connectionEpoch,
          exchangeID: "closing",
          command: { kind: "query", authorization: commandAuthorization(f, connection, "duplicate") },
        }),
      )
      await within(aborted.promise)
    }
    let closed = false
    const closing = connection.close().then(() => {
      closed = true
    })
    await within(aborted.promise)
    await Bun.sleep(0)
    expect(closed).toBeFalse()
    releaseClosing.resolve()
    await within(closing)
    expect(completed).toBe(admitted + 1)
    expect((await connection.closed).kind).toBe(limit === "count" ? "rejected" : "closed")
  })

test("the resident bridge stops after replacement or revocation without competing for another connection", async () => {
  for (const action of ["replace", "revoke"] as const) {
    await using f = await enrolled()
    const heartbeat = Promise.withResolvers<void>()
    f.interceptFrames((_socket, raw) => {
      if (Protocol.ClientFrame.parse(JSON.parse(String(raw))).type === "heartbeat") heartbeat.resolve()
      return false
    })
    await using bridge = startMemberBridge(f.options)
    await within(heartbeat.promise)
    if (action === "replace") {
      await using newer = await openMemberConnection(f.options)
      expect(await within(bridge.closed)).toMatchObject({ kind: "replaced" })
      expect(newer.connected.connectionEpoch).toBe(2)
    } else {
      await f.client.orgRuntime.revoke(
        { runtimeID: f.registration.runtimeID, orgRuntimeRevoke: { expectedRevision: f.registration.revision } },
        { headers: f.headers, throwOnError: true },
      )
      expect(await within(bridge.closed)).toMatchObject({ kind: "rejected" })
    }
  }
})

test("resident retry handles transient service errors while cancellation ends the owned lifecycle", async () => {
  await using f = await enrolled()
  const heartbeat = Promise.withResolvers<number>()
  let attempts = 0
  f.interceptFrames((socket, raw) => {
    const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type === "heartbeat") heartbeat.resolve(frame.connectionEpoch)
    else if (++attempts === 1) {
      socket.send(
        JSON.stringify({
          type: "error",
          error: { code: "SERVICE_UNAVAILABLE", message: "retry", retryable: true, outcome: "not_dispatched" },
        }),
      )
      socket.close()
      return true
    }
    return false
  })
  const controller = new AbortController()
  await using bridge = startMemberBridge({ ...f.options, signal: controller.signal })
  expect(await within(heartbeat.promise)).toBe(1)
  expect(attempts).toBe(2)
  controller.abort()
  expect(await within(bridge.closed)).toEqual({ kind: "closed" })
  await using cancelled = startMemberBridge({ ...f.options, signal: controller.signal })
  expect(await cancelled.closed).toEqual({ kind: "closed" })
  expect(attempts).toBe(2)
})

test("resident protocol and authorization failures remain terminal even with an invalid retry hint", async () => {
  await using f = await enrolled()
  let attempts = 0
  for (const code of ["PERMISSION_DENIED", "PROTOCOL_MISMATCH"] as const) {
    f.interceptFrames((socket) => {
      attempts++
      socket.send(
        JSON.stringify({ type: "error", error: { code, message: "denied", retryable: true, outcome: "rejected" } }),
      )
      return true
    })
    await using bridge = startMemberBridge(f.options)
    expect(await within(bridge.closed)).toMatchObject({ kind: "rejected", error: { code, outcome: "rejected" } })
  }
  expect(attempts).toBe(2)
  await using invalid = startMemberBridge({ ...f.options, identity: { ...f.identity, deviceID: "foreign-device" } })
  expect(await within(invalid.closed)).toMatchObject({
    kind: "rejected",
    error: { code: "SERVICE_UNAVAILABLE", retryable: false, outcome: "not_dispatched" },
  })
  expect(attempts).toBe(2)
})

test("the member bridge signs its own identity, heartbeats and durably advances its connection epoch", async () => {
  await using f = await enrolled()
  const heartbeat = Promise.withResolvers<void>()
  f.interceptFrames((_socket, raw) => {
    const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type === "heartbeat") heartbeat.resolve()
    else if (frame.type === "handshake") {
      expect(frame.proof.handshake).toMatchObject({
        ...f.identity,
        runtimeID: f.registration.runtimeID,
        capabilities: ["bridge"],
        schemas: { bridge: 1 },
      })
    }
    return false
  })
  await using first = await openMemberConnection(f.options)
  expect(first.connected.connectionEpoch).toBe(1)
  await heartbeat.promise
  const state = await f.client.orgRuntime.connection(
    { runtimeID: f.registration.runtimeID },
    { headers: f.headers, throwOnError: true },
  )
  expect(state.data).toMatchObject({ state: "online", connectionEpoch: 1 })
  await first.close()
  expect((await first.closed).kind).toBe("closed")
  await using second = await openMemberConnection({ ...f.options, buildVersion: "another-compatible-build" })
  expect(second.connected.connectionEpoch).toBe(2)
})

test("a lost local connection acknowledgment reconciles the server epoch and cannot revive an older socket", async () => {
  await using f = await enrolled()
  await using first = await openMemberConnection(f.options)
  await fs.rm(path.join(f.member.root, "organization-connection.json"))
  await using second = await openMemberConnection(f.options)
  expect(second.connected.connectionEpoch).toBe(2)
  expect((await first.closed).kind).toBe("replaced")
  await f.client.orgRuntime.revoke(
    { runtimeID: f.registration.runtimeID, orgRuntimeRevoke: { expectedRevision: f.registration.revision } },
    { headers: f.headers, throwOnError: true },
  )
  expect((await second.closed).kind).toBe("rejected")
  await expect(openMemberConnection(f.options)).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
})

test("the member bridge refuses a foreign handshake before publishing a connection checkpoint", async () => {
  await using f = await enrolled()
  f.interceptFrames((socket) => {
    socket.send(
      JSON.stringify({
        type: "handshake",
        protocolVersion: 1,
        orgID: "other",
        deploymentIncarnation: f.registration.deploymentIncarnation,
        runtimeID: f.registration.runtimeID,
        connectionEpoch: 1,
        heartbeatMs: 25,
        offlineMs: 300,
      }),
    )
    return true
  })
  await expect(openMemberConnection(f.options)).rejects.toMatchObject({ data: { code: "PROTOCOL_MISMATCH" } })
  expect(await Bun.file(path.join(f.member.root, "organization-connection.json")).exists()).toBe(false)
  f.interceptFrames(undefined)
  await using valid = await openMemberConnection(f.options)
  expect(valid.connected.connectionEpoch).toBe(1)
})

test("the member bridge rejects a signing identity from another deployment before saving its checkpoint", async () => {
  await using f = await enrolled()
  const first = await openMemberConnection(f.options)
  const identity = first.connected.signingIdentity
  await first.close()
  const filename = path.join(f.member.root, "organization-connection.json")
  const checkpoint = await Bun.file(filename).text()
  f.interceptFrames((socket) => {
    socket.send(
      JSON.stringify({
        type: "handshake",
        protocolVersion: 1,
        orgID: f.registration.orgID,
        deploymentIncarnation: f.registration.deploymentIncarnation,
        runtimeID: f.registration.runtimeID,
        connectionEpoch: 2,
        heartbeatMs: 25,
        offlineMs: 300,
        signingIdentity: { ...identity, deploymentIncarnation: "foreign-deployment" },
      }),
    )
    return true
  })
  await expect(openMemberConnection(f.options)).rejects.toMatchObject({ data: { code: "PROTOCOL_MISMATCH" } })
  expect(await Bun.file(filename).text()).toBe(checkpoint)
  f.interceptFrames(undefined)
  await using second = await openMemberConnection(f.options)
  expect(second.connected.signingIdentity).toEqual(identity)
  expect(second.connected.connectionEpoch).toBe(2)
})

test("heartbeat loss and caller cancellation settle the owned socket without claiming execution takeover", async () => {
  await using f = await enrolled()
  f.interceptFrames((_socket, raw) => Protocol.ClientFrame.parse(JSON.parse(String(raw))).type === "heartbeat")
  await using connected = await openMemberConnection(f.options)
  expect((await connected.closed).kind).toBe("offline")
  const opened = Promise.withResolvers<void>()
  f.interceptFrames(() => {
    opened.resolve()
    return true
  })
  const controller = new AbortController()
  const attempt = openMemberConnection({ ...f.options, signal: controller.signal }).then(
    () => undefined,
    (error: unknown) => error,
  )
  await opened.promise
  controller.abort()
  expect(await attempt).toMatchObject({ data: { code: "RUNTIME_OFFLINE" } })
  f.interceptFrames(undefined)
  await using again = await openMemberConnection(f.options)
  expect(again.connected.connectionEpoch).toBe(2)
})

test("cancellation releases a connection waiting to persist its acknowledgment without waiting for another owner", async () => {
  await using f = await enrolled()
  const directory = path.join(f.member.root, "state", ".locks")
  const key = "organization-connection"
  const acquired = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const holding = withFileLock({ directory, key }, async () => {
    acquired.resolve()
    await release.promise
  })
  await acquired.promise
  const open = fs.open.bind(fs)
  const observer = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === fileLockPath(directory, key) && args[1] === "wx") waiting.resolve()
    return open(...args)
  })
  const controller = new AbortController()
  const attempt = openMemberConnection({ ...f.options, signal: controller.signal }).then(
    () => undefined,
    (error: unknown) => error,
  )
  let rescued = false
  let rescue: ReturnType<typeof setTimeout> | undefined
  try {
    await waiting.promise
    controller.abort()
    rescue = setTimeout(() => {
      rescued = true
      release.resolve()
    }, 1000)
    expect(await attempt).toMatchObject({ data: { code: "RUNTIME_OFFLINE" } })
    expect(rescued).toBe(false)
    expect(await Bun.file(path.join(f.member.root, "organization-connection.json")).exists()).toBe(false)
  } finally {
    clearTimeout(rescue)
    observer.mockRestore()
    controller.abort()
    release.resolve()
    await holding
    await attempt
  }
})

test("malformed, binary, oversized and unsupported service frames fail without enrolling a connection", async () => {
  await using f = await enrolled()
  for (const frame of [
    "invalid",
    JSON.stringify({ type: "command", body: "unimplemented" }),
    "x".repeat(65537),
    new Uint8Array([1, 2]),
  ]) {
    f.interceptFrames((socket) => {
      socket.send(frame)
      return true
    })
    await expect(openMemberConnection(f.options)).rejects.toMatchObject({ data: { code: "PROTOCOL_MISMATCH" } })
    expect(await Bun.file(path.join(f.member.root, "organization-connection.json")).exists()).toBe(false)
  }
  f.interceptFrames((_socket, raw) => {
    const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type !== "heartbeat") return false
    _socket.send(JSON.stringify({ ...frame, sequence: frame.sequence + 1 }))
    return true
  })
  await using connected = await openMemberConnection(f.options)
  expect(await connected.closed).toMatchObject({ kind: "rejected", error: { code: "PROTOCOL_MISMATCH" } })
})

test("persisted epochs never regress to match an older service snapshot and foreign checkpoints block connection", async () => {
  await using f = await enrolled()
  const filename = path.join(f.member.root, "organization-connection.json")
  const checkpoint = {
    schemaVersion: 1,
    orgID: f.registration.orgID,
    deploymentIncarnation: f.registration.deploymentIncarnation,
    runtimeID: f.registration.runtimeID,
    connectionEpoch: 5,
  }
  await Bun.write(filename, JSON.stringify(checkpoint))
  await expect(openMemberConnection(f.options)).rejects.toMatchObject({
    data: { code: "STALE_CONNECTION", currentConnectionEpoch: 0 },
  })
  expect(await Bun.file(filename).json()).toEqual(checkpoint)
  await Bun.write(filename, JSON.stringify({ ...checkpoint, orgID: "other" }))
  await expect(openMemberConnection(f.options)).rejects.toThrow("identity")
})

test("untrusted TLS and cancellation before opening send no machine proof, and handshake timeout leaves no checkpoint", async () => {
  await using f = await enrolled()
  let frames = 0
  f.interceptFrames(() => {
    frames++
    return true
  })
  await expect(openMemberConnection({ ...f.options, ca: undefined })).rejects.toMatchObject({
    data: { code: "RUNTIME_OFFLINE" },
  })
  await expect(openMemberConnection({ ...f.options, signal: AbortSignal.abort() })).rejects.toMatchObject({
    data: { code: "RUNTIME_OFFLINE" },
  })
  expect(frames).toBe(0)
  await expect(openMemberConnection({ ...f.options, connectTimeoutMs: 100 })).rejects.toMatchObject({
    data: { code: "RUNTIME_OFFLINE" },
  })
  expect(frames).toBe(1)
  expect(await Bun.file(path.join(f.member.root, "organization-connection.json")).exists()).toBe(false)
})

test("the native machine bridge does not inherit a personal HTTP proxy", async () => {
  await using f = await enrolled()
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
  const previous = names.map((name) => process.env[name])
  let calls = 0
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++
      return new Response(null, { status: 502 })
    },
  })
  try {
    for (const name of names) process.env[name] = proxy.url.toString()
    await using connected = await openMemberConnection(f.options)
    expect(connected.connected.connectionEpoch).toBe(1)
    expect(calls).toBe(0)
  } finally {
    for (let index = 0; index < names.length; index++) {
      if (previous[index] === undefined) delete process.env[names[index]]
      else process.env[names[index]] = previous[index]
    }
    await proxy.stop(true)
  }
})
