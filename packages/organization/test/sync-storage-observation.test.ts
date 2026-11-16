import { expect, spyOn, test } from "bun:test"
import {
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSyncProtocol as Sync,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSharing as Sharing } from "../src/sharing"
import { createRuntimeConnections } from "../src/runtime-connection"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { digest } from "../src/auth/secret"
import { fixture, password } from "./support/organization"
import { connection, keys, proof } from "./support/runtime"

async function peer(url: URL) {
  const socket = new WebSocket(new URL("/runtime/v1/connect", url).toString().replace(/^http/, "ws"))
  const replies: Runtime.ServerFrame[] = []
  const waiting: Array<ReturnType<typeof Promise.withResolvers<Runtime.ServerFrame>>> = []
  const closed = Promise.withResolvers<void>()
  let discard = false
  socket.onmessage = (event) => {
    try {
      const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
      if (discard) {
        discard = false
        return
      }
      const next = waiting.shift()
      if (next) next.resolve(frame)
      else replies.push(frame)
    } catch (error) {
      for (const next of waiting.splice(0)) next.reject(error)
    }
  }
  socket.onclose = () => {
    closed.resolve()
    for (const next of waiting.splice(0)) next.reject(new Error("Original sync observation socket closed"))
  }
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error("Original sync observation socket could not open"))
  })
  return {
    closed: closed.promise,
    discardReply() {
      discard = true
    },
    send(frame: unknown) {
      socket.send(JSON.stringify(frame))
    },
    async exchange(frame: unknown) {
      if (replies.length) throw new Error("Original sync observation has an unsolicited frame")
      const next = Promise.withResolvers<Runtime.ServerFrame>()
      waiting.push(next)
      const timer = setTimeout(() => next.reject(new Error("Original sync observation did not reply")), 2000)
      try {
        socket.send(JSON.stringify(frame))
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
}

async function observedFixture() {
  const f = await fixture()
  const peers = new Set<Awaited<ReturnType<typeof peer>>>()
  let serverClosed = Promise.withResolvers<void>()
  let lastClosedPending: Promise<void> | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: f.service.fetch,
    websocket: {
      ...f.service.websocket,
      close(socket, code, reason) {
        lastClosedPending = socket.data.pending
        f.service.websocket.close?.(socket, code, reason)
        serverClosed.resolve()
        serverClosed = Promise.withResolvers<void>()
      },
    },
  })
  async function close() {
    const errors: unknown[] = []
    for (const value of peers) value[Symbol.dispose]()
    try {
      await server.stop(true)
    } catch (error) {
      errors.push(error)
    }
    try {
      await f[Symbol.asyncDispose]()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length) throw new AggregateError(errors, "Sync storage observation fixture cleanup failed")
  }
  try {
    await f.initialize()
    const client = createOrganizationClient({
      baseUrl: server.url.toString(),
      headers: { origin: "https://organization.example" },
    })
    const login = await client.orgAuth.login(
      { orgLoginInput: { loginName: "owner", password } },
      { throwOnError: true },
    )
    const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
    if (!cookie) throw new Error("Sync storage observation has no actual authenticated owner")
    const credentials = {
      token: Identity.Token.parse(cookie.slice(cookie.indexOf("=") + 1)),
      csrf: login.data.csrfToken,
    }
    const owner = createOrganizationClient({
      baseUrl: server.url.toString(),
      headers: { origin: "https://organization.example", cookie, "x-csrf-token": login.data.csrfToken },
    })
    const project = (
      await owner.orgProjects.create(
        { orgProjectCreate: { name: "Original sync storage observation" } },
        { throwOnError: true },
      )
    ).data
    async function member(deviceID: string) {
      const key = await keys()
      const ticket = Runtime.Ticket.parse(
        (
          await owner.orgRuntime.registerMember(
            { orgMemberRuntimeRegistration: { deviceID, publicKey: key.publicKey } },
            { throwOnError: true },
          )
        ).data,
      )
      const registration = Runtime.Registration.parse(
        (
          await owner.orgRuntime.consumeTicket(
            { orgRuntimeConsumeTicket: await proof(ticket, key.privateKey) },
            { throwOnError: true },
          )
        ).data,
      )
      return { key, registration, epoch: 0 }
    }
    const original = await member("observation-original")
    const session = await f.service.maintenance.run(() =>
      Directory.reservePrivate(credentials, {
        sessionID: "observation-root",
        projectID: project.projectID,
        runtimeID: original.registration.runtimeID,
      }),
    )
    const shared = (
      await owner.orgSessions.share(
        { sessionID: session.sessionID, orgShareChange: { expectedShareGeneration: 0 } },
        { throwOnError: true },
      )
    ).data
    async function open(version: 1 | 2, machine = original) {
      const value = await peer(server.url)
      peers.add(value)
      const epoch = ++machine.epoch
      const signed = await connection(machine.registration, machine.key.privateKey, epoch)
      signed.proof.handshake.capabilities.push("sync")
      signed.proof.handshake.schemas.sync = version
      signed.signature = await Runtime.sign(signed.proof, machine.key.privateKey)
      const reply = await value.exchange(signed)
      expect(reply).toMatchObject({ type: "handshake", connectionEpoch: epoch })
      return { ...value, epoch, reply }
    }
    const legacy = await open(1)
    if (legacy.reply.type !== "handshake") throw new Error("The original legacy producer has no actual handshake")
    const signingIdentity = legacy.reply.signingIdentity
    const root: Sync.Event = {
      type: "session",
      sequence: 1,
      session: {
        sessionID: session.sessionID,
        projectID: session.projectID,
        creatorID: session.creatorID,
        driverRuntimeID: session.driverRuntimeID,
        bindingEpoch: session.bindingEpoch,
        createdAt: session.createdAt,
        shareGeneration: shared.shareGeneration,
      },
    }
    function batch(events: Sync.Event[]) {
      const firstSeq = events[0]!.sequence
      const lastSeq = events.at(-1)!.sequence
      return Sync.Batch.parse({
        schemaVersion: 1,
        sessionID: session.sessionID,
        projectID: session.projectID,
        bindingEpoch: session.bindingEpoch,
        shareGeneration: shared.shareGeneration,
        firstSeq,
        lastSeq,
        events,
        payloadHash: digest(JSON.stringify({ firstSeq, lastSeq, events })),
      })
    }
    expect(
      await legacy.exchange({
        type: "sync-batch",
        connectionEpoch: legacy.epoch,
        exchangeID: "original-root",
        batch: batch([root]),
      }),
    ).toMatchObject({ type: "sync-ack", ack: { nextSeq: 2, syncState: "synced" } })
    legacy[Symbol.dispose]()
    await legacy.closed
    const checkpoint = { bindingEpoch: session.bindingEpoch, shareGeneration: shared.shareGeneration, nextSeq: 2 }
    return {
      owner,
      open,
      member,
      original,
      signingIdentity,
      sessionID: session.sessionID,
      checkpoint,
      batch,
      blocked: () => ({ ...checkpoint, state: "blocked", reason: "storage_full" }),
      async share() {
        return (await owner.orgSessions.shareState({ sessionID: session.sessionID }, { throwOnError: true })).data
      },
      run: <T>(body: () => Promise<T>) => f.service.maintenance.run(body),
      serverClosed: () => serverClosed.promise,
      drainClosed: async () => {
        await lastClosedPending
      },
      [Symbol.asyncDispose]: close,
    }
  } catch (error) {
    try {
      await close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Sync storage observation setup failed")
    }
    throw error
  }
}

function observation(
  f: Awaited<ReturnType<typeof observedFixture>>,
  remote: { epoch: number },
  value: unknown,
  exchangeID: string = crypto.randomUUID(),
) {
  return { type: "sync-state", connectionEpoch: remote.epoch, exchangeID, sessionID: f.sessionID, observation: value }
}

async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean) {
  const deadline = Date.now() + 2000
  for (;;) {
    const value = await read()
    if (accepts(value)) return value
    if (Date.now() >= deadline) throw new Error("Original sync storage observation did not settle")
    await Bun.sleep(10)
  }
}

test("signed sync two reports safe storage blockage without acknowledging content and recovers pending after a lost observation reply", async () => {
  await using f = await observedFixture()
  using remote = await f.open(2)
  expect(remote.reply).toMatchObject({ syncVersion: 2 })
  remote.discardReply()
  remote.send(observation(f, remote, f.blocked(), "blocked-lost-reply"))
  const blocked = await eventually(
    () => f.share(),
    (share) => share.syncState === "blocked",
  )
  expect(blocked).toMatchObject({ ...f.checkpoint, syncState: "blocked" })
  expect(await remote.exchange(observation(f, remote, f.blocked(), "blocked-exact-retry"))).toMatchObject({
    type: "sync-state",
    share: { ...f.checkpoint, syncState: "blocked" },
  })
  expect(await f.run(() => Storage.count({ prefix: Keys.sharedEvents(f.sessionID, 1) }))).toBe(1)
  remote.discardReply()
  remote.send(observation(f, remote, { ...f.checkpoint, state: "pending" }, "pending-lost-reply"))
  expect(
    await eventually(
      () => f.share(),
      (share) => share.syncState === "pending",
    ),
  ).toMatchObject({ ...f.checkpoint, syncState: "pending" })
  expect(
    await remote.exchange({
      type: "sync-state",
      connectionEpoch: remote.epoch,
      exchangeID: "recover-pending-read",
      sessionID: f.sessionID,
    }),
  ).toMatchObject({ type: "sync-state", share: { ...f.checkpoint, syncState: "pending" } })
  expect(await remote.exchange(observation(f, remote, { ...f.checkpoint, state: "pending" }))).toMatchObject({
    type: "sync-state",
    share: { ...f.checkpoint, syncState: "pending" },
  })
  const next: Sync.Event = {
    type: "message",
    sequence: 2,
    messageID: "original-next",
    role: "user",
    createdAt: 1,
    summary: "Original durable content",
    integrity: digest("original-next"),
  }
  expect(
    await remote.exchange({
      type: "sync-batch",
      connectionEpoch: remote.epoch,
      exchangeID: "actual-content",
      batch: f.batch([next]),
    }),
  ).toMatchObject({ type: "sync-ack", ack: { nextSeq: 3, syncState: "synced" } })
  expect(await f.share()).toMatchObject({ nextSeq: 3, syncState: "synced" })
  expect(await f.run(() => Storage.count({ prefix: Keys.sharedEvents(f.sessionID, 1) }))).toBe(2)
}, 15_000)

test("sync storage observations reject foreign drivers and stale generation binding checkpoint and connection selectors", async () => {
  await using f = await observedFixture()
  const invalid = [
    { ...f.blocked(), bindingEpoch: f.checkpoint.bindingEpoch + 1 },
    { ...f.blocked(), shareGeneration: f.checkpoint.shareGeneration + 1 },
    { ...f.blocked(), nextSeq: f.checkpoint.nextSeq + 1 },
  ]
  for (const [index, value] of invalid.entries()) {
    using remote = await f.open(2)
    expect(await remote.exchange(observation(f, remote, value))).toMatchObject({
      type: "error",
      error: { code: ["STALE_BINDING", "SHARE_REVOKED", "REVISION_CONFLICT"][index] },
    })
    expect(await f.share()).toMatchObject({ ...f.checkpoint, syncState: "synced" })
  }
  using foreign = await f.open(2, await f.member("observation-foreign"))
  expect(await foreign.exchange(observation(f, foreign, f.blocked()))).toMatchObject({
    type: "error",
    error: { code: "PERMISSION_DENIED" },
  })
  using stale = await f.open(2)
  expect(
    await stale.exchange({ ...observation(f, stale, f.blocked()), connectionEpoch: stale.epoch - 1 }),
  ).toMatchObject({ type: "error", error: { code: "STALE_CONNECTION" } })
  expect(await f.share()).toMatchObject({ ...f.checkpoint, syncState: "synced" })
}, 15_000)

test("legacy sync one keeps ordinary signed state reads and refuses storage observation fields", async () => {
  await using f = await observedFixture()
  using legacy = await f.open(1)
  expect("syncVersion" in legacy.reply).toBe(false)
  expect(
    await legacy.exchange({
      type: "sync-state",
      connectionEpoch: legacy.epoch,
      exchangeID: "legacy-read",
      sessionID: f.sessionID,
    }),
  ).toMatchObject({ type: "sync-state", share: { nextSeq: 2, syncState: "synced" } })
  expect(await legacy.exchange(observation(f, legacy, f.blocked()))).toMatchObject({
    type: "error",
    error: { code: "PROTOCOL_MISMATCH" },
  })
  expect(await f.share()).toMatchObject({ ...f.checkpoint, syncState: "synced" })
}, 15_000)

test("storage blockage observations reject arbitrary details and absent canonical checkpoints", async () => {
  await using f = await observedFixture()
  {
    using remote = await f.open(2)
    const rejected = await remote.exchange(
      observation(f, remote, { ...f.blocked(), detail: "not-a-permitted-error-field" }),
    )
    expect(rejected).toMatchObject({ type: "error", error: { code: "PROTOCOL_MISMATCH" } })
    expect(JSON.stringify(rejected)).not.toContain("not-a-permitted-error-field")
    expect(await f.share()).toMatchObject({ ...f.checkpoint, syncState: "synced" })
  }
  await f.run(() => Storage.remove(Keys.sharedState(f.sessionID)))
  using remote = await f.open(2)
  expect(await remote.exchange(observation(f, remote, f.blocked()))).toMatchObject({
    type: "error",
    error: { code: "SERVICE_UNAVAILABLE" },
  })
  expect(await f.run(() => Storage.readMany([Keys.sharedState(f.sessionID)]))).toEqual([undefined])
}, 15_000)

test("the original socket must remain live through the last sync storage observation commit", async () => {
  await using f = await observedFixture()
  using remote = await f.open(2)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const original = Storage.write
  let held = false
  const pending = spyOn(Storage, "write").mockImplementation(async (key, value) => {
    const result = await original(key, value)
    if (
      !held &&
      JSON.stringify(key) === JSON.stringify(Keys.sharedState(f.sessionID)) &&
      value &&
      typeof value === "object" &&
      "syncState" in value &&
      value.syncState === "blocked"
    ) {
      held = true
      entered.resolve()
      await release.promise
    }
    return result
  })
  const report = remote.exchange(observation(f, remote, f.blocked())).then(
    () => false,
    () => true,
  )
  try {
    await Promise.race([
      entered.promise,
      report.then(() => {
        if (!held) throw new Error("Storage observation ended before its original commit boundary")
      }),
    ])
    const originalClosed = f.serverClosed()
    remote[Symbol.dispose]()
    await originalClosed
    await remote.closed
  } finally {
    release.resolve()
    await report
    pending.mockRestore()
  }
  expect(held).toBe(true)
  expect(await f.share()).toMatchObject({ ...f.checkpoint, syncState: "synced" })
  expect(await f.run(() => Storage.count({ prefix: Keys.sharedEvents(f.sessionID, 1) }))).toBe(1)
}, 15_000)

test("a native sync two handshake cannot confirm a missing storage observation owner", async () => {
  await using f = await observedFixture()
  const connections = createRuntimeConnections({
    run: async (body) => f.run(async () => await body()),
    signingIdentity: f.signingIdentity,
    onSyncState: (lease, sessionID) => Sharing.getFromRuntime(lease.handshake, sessionID),
    onSyncBatch: (lease, batch) => Sharing.applyBatchFromRuntime(lease, batch),
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: connections.websocket,
    fetch(request, server) {
      if (
        new URL(request.url).pathname === "/runtime/v1/connect" &&
        server.upgrade(request, { data: connections.socket() })
      )
        return
      return new Response(null, { status: 404 })
    },
  })
  try {
    using remote = await peer(server.url)
    const signed = await connection(f.original.registration, f.original.key.privateKey, ++f.original.epoch)
    signed.proof.handshake.capabilities.push("sync")
    signed.proof.handshake.schemas.sync = 2
    signed.signature = await Runtime.sign(signed.proof, f.original.key.privateKey)
    expect(await remote.exchange(signed)).toMatchObject({ type: "error", error: { code: "PROTOCOL_MISMATCH" } })
    expect(await f.run(() => Storage.readMany([Keys.runtime(f.original.registration.runtimeID)]))).toMatchObject([
      { connectionEpoch: 1 },
    ])
    expect(await f.share()).toMatchObject({ ...f.checkpoint, syncState: "synced" })
  } finally {
    await server.stop(true)
    await f.run(async () => {
      connections.close()
    })
  }
}, 15_000)

test("a signed sync batch cannot commit after its original socket closes at the last native write", async () => {
  await using f = await observedFixture()
  using remote = await f.open(2)
  const batch = f.batch([
    Sync.Event.parse({
      type: "message",
      sequence: 2,
      messageID: "closing-original-batch",
      role: "assistant",
      createdAt: 2,
      summary: "Original accepted batch",
      integrity: digest("closing-original-batch"),
    }),
  ])
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const original = Storage.write
  let held = false
  const write = spyOn(Storage, "write").mockImplementation(async (key, value) => {
    const result = await original(key, value)
    if (
      !held &&
      JSON.stringify(key) === JSON.stringify(Keys.sharedState(f.sessionID)) &&
      value &&
      typeof value === "object" &&
      "nextSeq" in value &&
      value.nextSeq === 3
    ) {
      held = true
      entered.resolve()
      await release.promise
    }
    return result
  })
  const outcome = remote
    .exchange({ type: "sync-batch", connectionEpoch: remote.epoch, exchangeID: "close-original-batch", batch })
    .then(
      () => false,
      () => true,
    )
  try {
    await Promise.race([
      entered.promise,
      outcome.then(() => {
        if (!held) throw new Error("Original batch did not reach its actual final native write")
      }),
    ])
    const closed = f.serverClosed()
    remote[Symbol.dispose]()
    await closed
    await remote.closed
  } finally {
    release.resolve()
    await outcome
    await f.drainClosed()
    write.mockRestore()
  }
  expect(held).toBe(true)
  expect(await f.share()).toMatchObject({ ...f.checkpoint, syncState: "synced" })
  expect(await f.run(() => Storage.count({ prefix: Keys.sharedEvents(f.sessionID, 1) }))).toBe(1)
  expect(await f.run(() => Storage.readMany([Keys.sharedBatch(f.sessionID, 1, 2)]))).toEqual([undefined])
}, 15000)

test.each(["chunk", "complete"] as const)(
  "native blob %s publication retains the original socket through its commit",
  async (stage) => {
    await using f = await observedFixture()
    using remote = await f.open(2)
    const bytes = new TextEncoder().encode("native socket fence")
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
    const key = Keys.sharedBlob(f.sessionID, 1, hash)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = Storage.write
    let held = false
    const write = spyOn(Storage, "write").mockImplementation(async (record, value) => {
      const result = await original(record, value)
      if (
        !held &&
        JSON.stringify(record) === JSON.stringify(key) &&
        value &&
        typeof value === "object" &&
        "complete" in value &&
        value.complete === (stage === "complete")
      ) {
        held = true
        entered.resolve()
        await release.promise
      }
      return result
    })
    const outcome = remote
      .exchange({
        type: "blob-chunk",
        connectionEpoch: remote.epoch,
        exchangeID: `close-blob-${stage}`,
        sessionID: f.sessionID,
        shareGeneration: 1,
        hash,
        offset: 0,
        totalBytes: bytes.byteLength,
        index: 0,
        total: 1,
        data: Buffer.from(bytes).toString("base64url"),
      })
      .then(
        () => false,
        () => true,
      )
    try {
      await Promise.race([
        entered.promise,
        outcome.then(() => {
          if (!held) throw new Error(`Original blob did not reach its ${stage} native commit`)
        }),
      ])
      const closed = f.serverClosed()
      remote[Symbol.dispose]()
      await closed
      await remote.closed
    } finally {
      release.resolve()
      await outcome
      await f.drainClosed()
      write.mockRestore()
    }
    expect(held).toBe(true)
    const [stored] = await f.run(() => Storage.readMany([key]))
    if (stage === "chunk") {
      expect(stored).toBeUndefined()
      expect(await f.run(() => Storage.count({ prefix: [...key, "chunk-manifest"] }))).toBe(0)
      expect(
        await f.run(() =>
          Storage.artifactReferences({ prefix: Keys.sharedBlobChunk(f.sessionID, 1, hash, 0), limit: 1 }),
        ),
      ).toEqual([])
    } else {
      expect(stored).toMatchObject({ complete: false, receivedBytes: bytes.byteLength, nextOffset: bytes.byteLength })
      const actual = await f.run(() =>
        Storage.readBinary(Keys.sharedBlobChunk(f.sessionID, 1, hash, 0), { maxBytes: bytes.byteLength }),
      )
      expect(actual).toEqual(bytes)
    }
  },
  20000,
)
