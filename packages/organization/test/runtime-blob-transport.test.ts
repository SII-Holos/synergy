import { expect, spyOn, test } from "bun:test"
import { OrganizationRuntimeProtocol as Runtime } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationSharing as Sharing } from "../src/sharing"
import { fixture } from "./support/organization"
import { connection, consume, keys, proof, register } from "./support/runtime"

async function transportFixture() {
  const f = await fixture()
  const owner = await f.initialize()
  const key = await keys()
  const ticket = await register(owner, "blob-transport-device", key.publicKey)
  const runtime = Runtime.Registration.parse(await (await consume(f, await proof(ticket, key.privateKey))).json())
  let received = 0
  const sockets = new Set<Parameters<typeof f.service.websocket.message>[0]>()
  const observers: Array<{ count: number; done: ReturnType<typeof Promise.withResolvers<void>> }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: f.service.fetch,
    websocket: {
      ...f.service.websocket,
      open(socket) {
        sockets.add(socket)
        f.service.websocket.open?.(socket)
      },
      message(socket, raw) {
        f.service.websocket.message(socket, raw)
        received++
        for (const observer of observers) if (observer.count <= received) observer.done.resolve()
      },
    },
  })
  const upload = Sharing.uploadBlobFromRuntime
  let calls = 0
  let beforeUpload: (() => Promise<void>) | undefined
  const observation = spyOn(Sharing, "uploadBlobFromRuntime").mockImplementation(async (handshake, input) => {
    calls++
    await beforeUpload?.()
    return upload(handshake, input)
  })
  let epoch = 0
  async function peer(authenticated = true, sync = true) {
    const socket = new WebSocket(new URL("/runtime/v1/connect", server.url).toString().replace(/^http/, "ws"))
    const replies: Runtime.ServerFrame[] = []
    const waiting: Array<ReturnType<typeof Promise.withResolvers<Runtime.ServerFrame>>> = []
    const closed = Promise.withResolvers<CloseEvent>()
    socket.onmessage = (event) => {
      const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
      const next = waiting.shift()
      if (next) next.resolve(frame)
      else replies.push(frame)
    }
    socket.onclose = (event) => {
      closed.resolve(event)
      for (const next of waiting.splice(0)) next.reject(new Error("Blob transport closed before its reply"))
    }
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("Blob transport could not open"))
    })
    const peer = {
      epoch: authenticated ? ++epoch : 0,
      closed: closed.promise,
      async send(frame: unknown) {
        const done = Promise.withResolvers<void>()
        const observer = { count: received + 1, done }
        observers.push(observer)
        const timer = setTimeout(() => done.reject(new Error("The Service did not receive the test frame")), 2000)
        try {
          socket.send(JSON.stringify(frame))
          await done.promise
        } finally {
          clearTimeout(timer)
          observers.splice(observers.indexOf(observer), 1)
        }
      },
      async next() {
        const reply = replies.shift()
        if (reply) return reply
        const next = Promise.withResolvers<Runtime.ServerFrame>()
        waiting.push(next)
        const timer = setTimeout(() => next.reject(new Error("Blob transport did not reply")), 2000)
        try {
          return await next.promise
        } finally {
          clearTimeout(timer)
          const index = waiting.indexOf(next)
          if (index !== -1) waiting.splice(index, 1)
        }
      },
      [Symbol.dispose]() {
        socket.close()
      },
    }
    if (authenticated) {
      const signed = await connection(runtime, key.privateKey, peer.epoch)
      if (sync) {
        signed.proof.handshake.capabilities.push("sync")
        signed.proof.handshake.schemas.sync = 1
        signed.signature = await Runtime.sign(signed.proof, key.privateKey)
      }
      await peer.send(signed)
      expect(await peer.next()).toMatchObject({ type: "handshake", connectionEpoch: peer.epoch })
    }
    return peer
  }
  return {
    peer,
    calls: () => calls,
    async drain() {
      await Promise.all([...sockets].map((socket) => socket.data.pending))
    },
    hold(value: () => Promise<void>) {
      beforeUpload = value
    },
    async [Symbol.asyncDispose]() {
      observation.mockRestore()
      await server.stop(true)
      await f[Symbol.asyncDispose]()
    },
  }
}

type Peer = Awaited<ReturnType<Awaited<ReturnType<typeof transportFixture>>["peer"]>>
function fragment(peer: Peer, value: Partial<Runtime.BlobChunk> = {}): Runtime.BlobChunk {
  return {
    type: "blob-chunk",
    connectionEpoch: peer.epoch,
    exchangeID: "blob-exchange",
    sessionID: "not-an-authorized-shared-session",
    shareGeneration: 1,
    hash: "a".repeat(64),
    offset: 0,
    totalBytes: 2,
    index: 0,
    total: 2,
    data: "YQ",
    ...value,
  }
}
async function heartbeat(peer: Peer, sequence: number) {
  await peer.send({ type: "heartbeat", connectionEpoch: peer.epoch, sequence })
  expect(await peer.next()).toEqual({ type: "heartbeat", connectionEpoch: peer.epoch, sequence })
}
async function rejected(peer: Peer, code: string) {
  expect(await peer.next()).toMatchObject({ type: "error", error: { code } })
  await peer.closed
}

test("blob transport retains only strict contiguous fragments and does not grant partial bytes domain authority", async () => {
  await using f = await transportFixture()
  {
    using peer = await f.peer(false)
    await peer.send(fragment(peer, { connectionEpoch: 1 }))
    await rejected(peer, "AUTHENTICATION_REQUIRED")
  }
  {
    using peer = await f.peer(true, false)
    await peer.send(fragment(peer))
    await rejected(peer, "PROTOCOL_MISMATCH")
  }
  for (const invalid of [{ connectionEpoch: 1 }, { data: "AB" }, { index: 1 }, { total: 129 }]) {
    using peer = await f.peer()
    await peer.send(fragment(peer, invalid))
    await rejected(peer, "connectionEpoch" in invalid ? "STALE_CONNECTION" : "PROTOCOL_MISMATCH")
  }
  for (const change of [
    { sessionID: "another-session" },
    { shareGeneration: 2 },
    { hash: "b".repeat(64) },
    { offset: 1 },
    { totalBytes: 3 },
    { total: 3 },
    { index: 0 },
  ]) {
    using peer = await f.peer()
    await peer.send(fragment(peer))
    await heartbeat(peer, 1)
    expect(f.calls()).toBe(0)
    await peer.send(fragment(peer, { index: 1, ...change }))
    await rejected(peer, "PROTOCOL_MISMATCH")
  }
  expect(f.calls()).toBe(0)
  using peer = await f.peer()
  await peer.send(fragment(peer))
  await heartbeat(peer, 1)
  expect(f.calls()).toBe(0)
  await peer.send(fragment(peer, { index: 1 }))
  await rejected(peer, "PERMISSION_DENIED")
  expect(f.calls()).toBe(1)
})

test("partial blob groups and their aggregate decoded bytes share the original receive bounds", async () => {
  await using f = await transportFixture()
  {
    using peer = await f.peer()
    for (let group = 0; group < 15; group++) {
      await peer.send(fragment(peer, { exchangeID: `group-${group}` }))
      await heartbeat(peer, group + 1)
    }
    await peer.send(fragment(peer, { exchangeID: "group-15" }))
    await peer.send(fragment(peer, { exchangeID: "group-16" }))
    await rejected(peer, "SERVICE_UNAVAILABLE")
  }
  {
    using peer = await f.peer()
    const data = Buffer.alloc(45_000, 7).toString("base64url")
    for (let index = 0; index < 46; index++) {
      for (let group = 0; group < 2; group++)
        await peer.send(
          fragment(peer, { exchangeID: `bytes-${group}`, total: 128, totalBytes: 8_388_608, index, data }),
        )
      await heartbeat(peer, index + 1)
    }
    await peer.send(fragment(peer, { exchangeID: "bytes-0", total: 128, totalBytes: 8_388_608, index: 46, data }))
    await heartbeat(peer, 47)
    await peer.send(fragment(peer, { exchangeID: "bytes-1", total: 128, totalBytes: 8_388_608, index: 46, data }))
    await rejected(peer, "SERVICE_UNAVAILABLE")
  }
  expect(f.calls()).toBe(0)
})

test("replacement cannot dispatch a complete blob queued behind an original in-flight domain operation", async () => {
  await using f = await transportFixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const settled = Promise.withResolvers<void>()
  f.hold(async () => {
    entered.resolve()
    try {
      await release.promise
    } finally {
      settled.resolve()
    }
  })
  using first = await f.peer()
  try {
    await first.send(fragment(first, { exchangeID: "in-flight", total: 1, totalBytes: 1 }))
    await entered.promise
    await first.send(fragment(first, { exchangeID: "queued", total: 1, totalBytes: 1 }))
    using replacement = await f.peer()
    expect((await first.closed).code).toBe(4001)
    release.resolve()
    await settled.promise
    await f.drain()
    await heartbeat(replacement, 1)
    expect(f.calls()).toBe(1)
  } finally {
    release.resolve()
  }
})
