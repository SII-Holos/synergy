import { expect, spyOn, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { StoreTransaction, TransactionOptions } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import type { ServerWebSocket } from "bun"
import type { RuntimeSocket } from "../src/runtime-connection"
import {
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { fixture, password } from "./support/organization"
import { keys, proof, consume, register, connection } from "./support/runtime"

async function peer(url: URL) {
  const ws = new WebSocket(new URL("/runtime/v1/connect", url).toString().replace(/^http/, "ws"))
  const frames: unknown[] = []
  const waiting: Array<ReturnType<typeof Promise.withResolvers<unknown>>> = []
  const closed = Promise.withResolvers<CloseEvent>()
  ws.onmessage = (event) => {
    const frame: unknown = JSON.parse(String(event.data))
    const next = waiting.shift()
    if (next) next.resolve(frame)
    else frames.push(frame)
  }
  ws.onclose = (event) => {
    closed.resolve(event)
    for (const next of waiting.splice(0)) next.reject(new Error("Runtime socket closed"))
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error("Runtime socket failed to open"))
  })
  return {
    send(frame: unknown) {
      ws.send(JSON.stringify(frame))
    },
    raw(frame: string | Uint8Array<ArrayBuffer>) {
      ws.send(frame)
    },
    closed: closed.promise,
    async next() {
      if (frames.length) return frames.shift()
      const next = Promise.withResolvers<unknown>()
      waiting.push(next)
      const timeout = setTimeout(() => next.reject(new Error("Runtime frame timed out")), 2000)
      try {
        return await next.promise
      } finally {
        clearTimeout(timeout)
      }
    },
    [Symbol.dispose]() {
      ws.close()
    },
  }
}

test("real Runtime connections authenticate, fence replacements and revoke independently of human cookies", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const key = await keys()
  const ticket = await register(owner, "connection-device", key.publicKey)
  const runtime = Runtime.Registration.parse(await (await consume(f, await proof(ticket, key.privateKey))).json())
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.service.fetch, websocket: f.service.websocket })
  try {
    using first = await peer(server.url)
    const signed = await connection(runtime, key.privateKey, 1)
    first.send(signed)
    expect(await first.next()).toMatchObject({ type: "handshake", runtimeID: runtime.runtimeID, connectionEpoch: 1 })
    first.send({ type: "heartbeat", connectionEpoch: 1, sequence: 1 })
    expect(await first.next()).toEqual({ type: "heartbeat", connectionEpoch: 1, sequence: 1 })
    expect(await (await owner.request("GET", `/runtimes/${runtime.runtimeID}/connection`)).json()).toMatchObject({
      state: "online",
      connectionEpoch: 1,
    })
    using replay = await peer(server.url)
    replay.send(signed)
    expect(await replay.next()).toMatchObject({
      type: "error",
      error: { code: "STALE_CONNECTION", currentConnectionEpoch: 1 },
    })
    await replay.closed
    using second = await peer(server.url)
    second.send(await connection(runtime, key.privateKey, 2))
    expect(await second.next()).toMatchObject({ type: "handshake", connectionEpoch: 2 })
    expect((await first.closed).code).toBe(4001)
    second.send({ type: "heartbeat", connectionEpoch: 1, sequence: 2 })
    expect(await second.next()).toMatchObject({ type: "error", error: { code: "STALE_CONNECTION" } })
    await second.closed
    using third = await peer(server.url)
    third.send(await connection(runtime, key.privateKey, 3))
    expect(await third.next()).toMatchObject({ type: "handshake", connectionEpoch: 3 })
    const current = Runtime.Registration.parse(
      await (await owner.request("GET", `/runtimes/${runtime.runtimeID}`)).json(),
    )
    expect(
      (await owner.request("POST", `/runtimes/${runtime.runtimeID}/revoke`, { expectedRevision: current.revision }))
        .status,
    ).toBe(200)
    expect((await third.closed).code).toBe(4003)
    using revoked = await peer(server.url)
    revoked.send(await connection(runtime, key.privateKey, 4))
    expect(await revoked.next()).toMatchObject({ type: "error", error: { code: "PERMISSION_DENIED" } })
    expect(await (await owner.request("GET", `/runtimes/${runtime.runtimeID}/connection`)).json()).toMatchObject({
      state: "offline",
      connectionEpoch: 3,
    })
  } finally {
    await server.stop(true)
  }
})

test("simultaneous handshakes have one winner and account removal closes that machine's current connection", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const invitation = (await (await owner.request("POST", "/invites", { role: "member" })).json()) as { token: string }
  const member = f.client()
  const account = Identity.Account.parse(
    await (
      await member.request("POST", "/invites/consume", {
        token: invitation.token,
        requestID: crypto.randomUUID(),
        loginName: "member",
        displayName: "Member",
        password,
      })
    ).json(),
  )
  await member.login("member")
  const key = await keys()
  const ticket = await register(member, "concurrent-device", key.publicKey)
  const runtime = Runtime.Registration.parse(await (await consume(f, await proof(ticket, key.privateKey))).json())
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.service.fetch, websocket: f.service.websocket })
  try {
    using first = await peer(server.url)
    using second = await peer(server.url)
    const signed = await connection(runtime, key.privateKey, 1)
    first.send(signed)
    second.send(signed)
    const frames = await Promise.all([first.next(), second.next()])
    expect(frames.filter((value) => Runtime.ServerFrame.parse(value).type === "handshake")).toHaveLength(1)
    expect(frames.filter((value) => Runtime.ServerFrame.parse(value).type === "error")).toHaveLength(1)
    expect(
      (
        await owner.request("PATCH", `/accounts/${account.accountID}`, {
          expectedRevision: account.revision,
          state: "removed",
        })
      ).status,
    ).toBe(200)
    const closed = await Promise.all([first.closed, second.closed])
    expect(closed.map((event) => event.code).sort()).toEqual([4001, 4003])
    using removed = await peer(server.url)
    removed.send(await connection(runtime, key.privateKey, 2))
    expect(await removed.next()).toMatchObject({ type: "error", error: { code: "PERMISSION_DENIED" } })
  } finally {
    await server.stop(true)
  }
})

test("the machine bridge refuses browser credentials, incompatible versions and invalid or oversized frames", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const key = await keys()
  const ticket = await register(owner, "validation-device", key.publicKey)
  const runtime = Runtime.Registration.parse(await (await consume(f, await proof(ticket, key.privateKey))).json())
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.service.fetch, websocket: f.service.websocket })
  try {
    for (const headers of [
      new Headers({ origin: "https://organization.example" }),
      new Headers({ cookie: "human-login" }),
    ])
      expect((await fetch(new URL("/runtime/v1/connect", server.url), { headers })).status).toBe(400)
    expect((await fetch(new URL("/runtime/v1/connect?token=private", server.url))).status).toBe(400)
    expect((await fetch(new URL("/runtime/v1/connect", server.url))).status).toBe(400)
    expect((await f.service.fetch(new Request("https://organization.example/runtime/v1/connect"))).status).toBe(503)
    for (const frame of [
      { type: "heartbeat", connectionEpoch: 1, sequence: 1 },
      { type: "command", body: "private" },
    ]) {
      using invalid = await peer(server.url)
      invalid.send(frame)
      expect(Runtime.ServerFrame.parse(await invalid.next()).type).toBe("error")
    }
    using binary = await peer(server.url)
    binary.raw(new Uint8Array([0, 1]))
    expect(await binary.next()).toMatchObject({ type: "error", error: { code: "INVALID_REQUEST" } })
    using json = await peer(server.url)
    json.raw("not-json-private-content")
    expect(JSON.stringify(await json.next())).not.toContain("private-content")
    using version = await peer(server.url)
    const signed = await connection(runtime, key.privateKey, 1)
    version.send({
      ...signed,
      proof: { ...signed.proof, handshake: { ...signed.proof.handshake, protocolVersion: 2 } },
    })
    expect(await version.next()).toMatchObject({ type: "error", error: { code: "PROTOCOL_MISMATCH" } })
    using schema = await peer(server.url)
    const incompatible = { ...signed.proof, handshake: { ...signed.proof.handshake, schemas: { bridge: 2 } } }
    schema.send({ type: "handshake", proof: incompatible, signature: await Runtime.sign(incompatible, key.privateKey) })
    expect(await schema.next()).toMatchObject({ type: "error", error: { code: "PROTOCOL_MISMATCH" } })
    using oversized = await peer(server.url)
    oversized.raw("x".repeat(64 * 1024 + 1))
    await oversized.closed
    using valid = await peer(server.url)
    valid.send(signed)
    expect(await valid.next()).toMatchObject({ type: "handshake", connectionEpoch: 1 })
    valid.send(signed)
    expect(await valid.next()).toMatchObject({ type: "error", error: { code: "INVALID_REQUEST" } })
  } finally {
    await server.stop(true)
  }
})

test("restart keeps connection epochs, rejects altered machine claims and expires silent peers", async () => {
  await using f = await fixture(undefined, { connections: { authenticateMs: 400, heartbeatMs: 100, offlineMs: 600 } })
  const owner = await f.initialize()
  const key = await keys()
  const ticket = await register(owner, "restart-device", key.publicKey)
  const runtime = Runtime.Registration.parse(await (await consume(f, await proof(ticket, key.privateKey))).json())
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.service.fetch, websocket: f.service.websocket })
  try {
    using silent = await peer(server.url)
    expect((await silent.closed).code).toBe(4008)
    using malformed = await peer(server.url)
    const signed = await connection(runtime, key.privateKey, 1)
    malformed.send({
      ...signed,
      proof: { ...signed.proof, handshake: { ...signed.proof.handshake, accountID: "foreign" } },
    })
    expect(await malformed.next()).toMatchObject({ type: "error", error: { code: "AUTHENTICATION_REQUIRED" } })
    using first = await peer(server.url)
    first.send(signed)
    expect(await first.next()).toMatchObject({ type: "handshake", connectionEpoch: 1 })
    expect((await first.closed).code).toBe(4008)
    expect(await (await owner.request("GET", `/runtimes/${runtime.runtimeID}/connection`)).json()).toMatchObject({
      state: "offline",
      connectionEpoch: 1,
    })
    await f.restart()
  } finally {
    await server.stop(true)
  }
  const restarted = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: f.service.fetch,
    websocket: f.service.websocket,
  })
  try {
    using old = await peer(restarted.url)
    old.send(await connection(runtime, key.privateKey, 1))
    expect(await old.next()).toMatchObject({
      type: "error",
      error: { code: "STALE_CONNECTION", currentConnectionEpoch: 1 },
    })
    using active = await peer(restarted.url)
    active.send(await connection(runtime, key.privateKey, 2))
    expect(await active.next()).toMatchObject({ type: "handshake", connectionEpoch: 2 })
    await f.service.close()
    expect((await active.closed).code).toBe(1001)
  } finally {
    await restarted.stop(true)
  }
})

test("dropped and throwing native sends disconnect only the affected Runtime and leave no false online state", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const key = await keys()
  const first = await register(owner, "healthy-device", key.publicKey)
  const second = await register(owner, "failed-send-device", key.publicKey)
  const healthyRuntime = Runtime.Registration.parse(await (await consume(f, await proof(first, key.privateKey))).json())
  const failingRuntime = Runtime.Registration.parse(
    await (await consume(f, await proof(second, key.privateKey))).json(),
  )
  let fault: "none" | "drop" | "throw" | "backpressure" = "none"
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: f.service.fetch,
    websocket: {
      ...f.service.websocket,
      open(socket) {
        f.service.websocket.open?.(socket)
        if (fault === "drop") socket.send = () => 0
        if (fault === "throw")
          socket.send = () => {
            throw new Error("native send failed")
          }
        if (fault === "backpressure") socket.getBufferedAmount = () => 65_537
      },
    },
  })
  try {
    using healthy = await peer(server.url)
    healthy.send(await connection(healthyRuntime, key.privateKey, 1))
    expect(await healthy.next()).toMatchObject({ type: "handshake" })
    let epoch = 0
    for (const failure of ["drop", "throw", "backpressure"] as const) {
      fault = failure
      using failed = await peer(server.url)
      failed.send(await connection(failingRuntime, key.privateKey, ++epoch))
      await failed.closed
      expect(
        await (await owner.request("GET", `/runtimes/${failingRuntime.runtimeID}/connection`)).json(),
      ).toMatchObject({ state: "offline", connectionEpoch: epoch })
      healthy.send({ type: "heartbeat", connectionEpoch: 1, sequence: epoch })
      expect(await healthy.next()).toEqual({ type: "heartbeat", connectionEpoch: 1, sequence: epoch })
    }
  } finally {
    await server.stop(true)
  }
})

test("a socket closed at the SQL commit boundary cannot publish a successful connection epoch", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const key = await keys()
  const ticket = await register(owner, "commit-device", key.publicKey)
  const runtime = Runtime.Registration.parse(await (await consume(f, await proof(ticket, key.privateKey))).json())
  let socket: ServerWebSocket<RuntimeSocket> | undefined
  const closed = Promise.withResolvers<void>()
  const settled = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: f.service.fetch,
    websocket: {
      ...f.service.websocket,
      open(value) {
        socket = value
        f.service.websocket.open?.(value)
      },
      close(value) {
        f.service.websocket.close?.(value, 1000, "")
        closed.resolve()
      },
    },
  })
  const transaction = Storage.transaction
  let armed = true
  const barrier = spyOn(Storage, "transaction").mockImplementation(
    async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
      if (!armed || !options?.commitGuard) return transaction(body, options)
      armed = false
      try {
        return await transaction(async (tx) => {
          const result = await body(tx)
          socket!.close(1000)
          await closed.promise
          return result
        }, options)
      } finally {
        settled.resolve()
      }
    },
  )
  try {
    using disconnected = await peer(server.url)
    disconnected.send(await connection(runtime, key.privateKey, 1))
    await disconnected.closed
    await settled.promise
    expect(
      Runtime.Registration.parse(await (await owner.request("GET", `/runtimes/${runtime.runtimeID}`)).json())
        .connectionEpoch,
    ).toBe(0)
    using retry = await peer(server.url)
    retry.send(await connection(runtime, key.privateKey, 1))
    expect(await retry.next()).toMatchObject({ type: "handshake", connectionEpoch: 1 })
  } finally {
    barrier.mockRestore()
    await server.stop(true)
  }
})
