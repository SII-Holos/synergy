import { expect, spyOn, test } from "bun:test"
import type { Server } from "bun"
import {
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { digest } from "../src/auth/secret"
import type { RuntimeSocket } from "../src/runtime-connection"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSharedProjection as Projection } from "../src/shared-projection"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { fixture, password } from "./support/organization"
import { connection, keys, proof } from "./support/runtime"

async function peer(url: URL) {
  const socket = new WebSocket(new URL("/runtime/v1/connect", url).toString().replace(/^http/, "ws"))
  const queued: Runtime.ServerFrame[] = []
  const waiting: Array<ReturnType<typeof Promise.withResolvers<Runtime.ServerFrame>>> = []
  socket.onmessage = (event) => {
    try {
      const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
      const next = waiting.shift()
      if (next) next.resolve(frame)
      else queued.push(frame)
    } catch (error) {
      for (const next of waiting.splice(0)) next.reject(error)
    }
  }
  socket.onclose = () => {
    for (const next of waiting.splice(0)) next.reject(new Error("Projection Runtime closed before acknowledgement"))
  }
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error("Projection Runtime could not connect"))
  })
  return {
    async exchange(frame: unknown) {
      const result = queued.shift()
      if (result) throw new Error("Projection Runtime received an unsolicited frame")
      const next = Promise.withResolvers<Runtime.ServerFrame>()
      waiting.push(next)
      const timer = setTimeout(() => next.reject(new Error("Projection Runtime did not acknowledge its frame")), 2000)
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

async function signedFixture(messages: number, readers = 10) {
  const f = await fixture()
  let server: Server<RuntimeSocket> | undefined
  let transport: Awaited<ReturnType<typeof peer>> | undefined
  async function close() {
    const errors: unknown[] = []
    try {
      transport?.[Symbol.dispose]()
    } catch (error) {
      errors.push(error)
    }
    try {
      await server?.stop(true)
    } catch (error) {
      errors.push(error)
    }
    try {
      await f[Symbol.asyncDispose]()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length) throw new AggregateError(errors, "Signed projection fixture cleanup failed")
  }
  try {
    await f.initialize()
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: f.service.fetch,
      websocket: f.service.websocket,
    })
    const url = server.url
    async function login() {
      const client = createOrganizationClient({
        baseUrl: url.toString(),
        headers: { origin: "https://organization.example" },
      })
      const login = await client.orgAuth.login(
        { orgLoginInput: { loginName: "owner", password } },
        { throwOnError: true },
      )
      const setCookie = login.response.headers.get("set-cookie")
      if (!setCookie) throw new Error("Projection reader has no actual login cookie")
      const cookie = setCookie.split(";")[0]
      if (!cookie) throw new Error("Projection reader has no actual login cookie")
      const token = Identity.Token.parse(cookie.slice(cookie.indexOf("=") + 1))
      return {
        client: createOrganizationClient({
          baseUrl: url.toString(),
          headers: {
            origin: "https://organization.example",
            cookie,
            "x-csrf-token": login.data.csrfToken,
          },
        }),
        headers: { cookie, "x-csrf-token": login.data.csrfToken },
        credentials: { token, csrf: login.data.csrfToken },
      }
    }
    const owner = await login()
    const project = (
      await owner.client.orgProjects.create(
        { orgProjectCreate: { name: "Signed projection coverage" } },
        { throwOnError: true },
      )
    ).data
    const key = await keys()
    const ticket = Runtime.Ticket.parse(
      (
        await owner.client.orgRuntime.registerMember(
          {
            orgMemberRuntimeRegistration: {
              deviceID: "projection-coverage",
              publicKey: key.publicKey,
            },
          },
          { throwOnError: true },
        )
      ).data,
    )
    const runtime = Runtime.Registration.parse(
      (
        await owner.client.orgRuntime.consumeTicket(
          {
            orgRuntimeConsumeTicket: await proof(ticket, key.privateKey),
          },
          { throwOnError: true },
        )
      ).data,
    )
    transport = await peer(url)
    const signed = await connection(runtime, key.privateKey, 1)
    signed.proof.handshake.capabilities.push("sync")
    signed.proof.handshake.schemas.sync = 1
    signed.signature = await Runtime.sign(signed.proof, key.privateKey)
    expect(await transport.exchange(signed)).toMatchObject({
      type: "handshake",
      runtimeID: runtime.runtimeID,
      connectionEpoch: 1,
    })
    const session = await f.service.maintenance.run(() =>
      Directory.reservePrivate(owner.credentials, {
        sessionID: "signed-projection-coverage",
        projectID: project.projectID,
        runtimeID: runtime.runtimeID,
      }),
    )
    const share = (
      await owner.client.orgSessions.share(
        {
          sessionID: session.sessionID,
          orgShareChange: { expectedShareGeneration: 0 },
        },
        { throwOnError: true },
      )
    ).data
    expect(share.shareGeneration).toBe(1)
    let sequence = 0
    async function append(events: Sync.Event[]) {
      if (!transport) throw new Error("Original projection Runtime is unavailable")
      for (let offset = 0; offset < events.length; offset += 256) {
        const selected = events.slice(offset, offset + 256)
        const firstSeq = selected[0]!.sequence
        const lastSeq = selected.at(-1)!.sequence
        const batch = Sync.Batch.parse({
          schemaVersion: 1,
          sessionID: session.sessionID,
          projectID: session.projectID,
          bindingEpoch: session.bindingEpoch,
          shareGeneration: share.shareGeneration,
          firstSeq,
          lastSeq,
          payloadHash: digest(JSON.stringify({ firstSeq, lastSeq, events: selected })),
          events: selected,
        })
        expect(
          await transport.exchange({
            type: "sync-batch",
            connectionEpoch: 1,
            exchangeID: `batch-${firstSeq}`,
            batch,
          }),
        ).toMatchObject({
          type: "sync-ack",
          exchangeID: `batch-${firstSeq}`,
          ack: { nextSeq: lastSeq + 1, syncState: "synced" },
        })
        sequence = lastSeq
      }
    }
    const events: Sync.Event[] = [
      {
        type: "session",
        sequence: 1,
        session: {
          sessionID: session.sessionID,
          projectID: session.projectID,
          creatorID: session.creatorID,
          driverRuntimeID: session.driverRuntimeID,
          bindingEpoch: session.bindingEpoch,
          createdAt: session.createdAt,
          shareGeneration: share.shareGeneration,
        },
      },
    ]
    for (let index = 0; index < messages; index++) {
      const messageID = `message-${String(index).padStart(4, "0")}`
      events.push({
        type: "message",
        sequence: events.length + 1,
        messageID,
        role: "assistant",
        createdAt: index + 1,
        summary: `Message ${index}`,
        integrity: digest(messageID),
      })
      events.push({
        type: "part",
        sequence: events.length + 1,
        messageID,
        partID: `part-${index}`,
        part: {
          type: "text",
          content: { kind: "inline", text: `Signed text ${index}` },
        },
        integrity: digest(`text-${index}`),
      })
    }
    await append(events)
    const clients = await Promise.all(Array.from({ length: readers }, login))
    expect(new Set(clients.map((value) => value.credentials.token)).size).toBe(readers)
    return {
      owner: owner.client,
      invalidQuery(endpoint: "events" | "snapshot" | "search", value: string) {
        const target = new URL(`/org/v1/sessions/${session.sessionID}/sync/${endpoint}`, url)
        target.searchParams.set("limit", "1")
        target.searchParams.set(endpoint === "snapshot" ? "watermark" : "cursor", value)
        if (endpoint === "search") target.searchParams.set("q", "Message")
        return fetch(target, { headers: owner.headers })
      },
      clients: clients.map((value) => value.client),
      projectID: project.projectID,
      sessionID: session.sessionID,
      generation: share.shareGeneration,
      watermark: sequence,
      appendMessage() {
        const messageID = "later-message"
        return append([
          {
            type: "message",
            sequence: sequence + 1,
            messageID,
            role: "assistant",
            createdAt: messages + 1,
            summary: "Later message",
            integrity: digest(messageID),
          },
        ])
      },
      run: <T>(body: () => Promise<T>) => f.service.maintenance.run(body),
      [Symbol.asyncDispose]: close,
    }
  } catch (error) {
    try {
      await close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Signed projection fixture setup and cleanup failed")
    }
    throw error
  }
}

function observeReplay(sessionID: string, generation: number) {
  const original = Storage.query
  const prefix = Keys.sharedEvents(sessionID, generation)
  let pages = 0
  let rows = 0
  const observation = spyOn(Storage, "query").mockImplementation(
    async <T>(input: Parameters<typeof Storage.query>[0]) => {
      const result = await original<T>(input)
      if (JSON.stringify(input.prefix) === JSON.stringify(prefix)) {
        pages++
        rows += result.length
      }
      return result
    },
  )
  return {
    pages: () => pages,
    rows: () => rows,
    [Symbol.dispose]: () => observation.mockRestore(),
  }
}

test("ten authenticated HTTP readers use the projection atomically maintained by signed batches without replaying its fresh generation", async () => {
  await using f = await signedFixture(512)
  using replay = observeReplay(f.sessionID, f.generation)
  const pages = await Promise.all(
    f.clients.map(async (client) => {
      const [directory, snapshot, messages] = await Promise.all([
        client.orgSessions.list({ projectID: f.projectID, limit: 50 }, { throwOnError: true }),
        client.orgSessionSync.snapshot({ sessionID: f.sessionID, limit: 50 }, { throwOnError: true }),
        client.orgSessionSync.messages({ sessionID: f.sessionID, limit: 50, latest: true }, { throwOnError: true }),
      ])
      expect(directory.data.items.some((item) => item.sessionID === f.sessionID)).toBe(true)
      expect(snapshot.data.items).toHaveLength(50)
      expect(messages.data.items).toHaveLength(50)
      expect(snapshot.data.watermark).toBe(f.watermark)
      expect(messages.data.watermark).toBe(f.watermark)
      expect(snapshot.data.cursor).toBeString()
      expect(messages.data.cursor).toBeString()
      return { snapshot: snapshot.data, messages: messages.data }
    }),
  )
  expect(replay.pages()).toBe(0)
  expect(replay.rows()).toBe(0)
  const first = pages[0]
  if (!first?.messages.cursor) throw new Error("Signed first message page has no replay cursor")
  await f.appendMessage()
  const fixed = (
    await f.owner.orgSessionSync.messages(
      { sessionID: f.sessionID, limit: 50, cursor: first.messages.cursor },
      { throwOnError: true },
    )
  ).data
  expect(fixed.watermark).toBe(first.messages.watermark)
  expect(fixed.items).toHaveLength(50)
  expect(fixed.items.some((event) => event.messageID === "later-message")).toBe(false)
  await f.owner.orgSessions.unshare(
    {
      sessionID: f.sessionID,
      orgShareChange: { expectedShareGeneration: f.generation },
    },
    { throwOnError: true },
  )
  const denied = await f.clients[0]!.orgSessionSync.snapshot({
    sessionID: f.sessionID,
    limit: 50,
  })
  expect(denied.response.status).toBe(409)
  expect(denied.error?.code).toBe("SHARE_REVOKED")
}, 30_000)

test("a retained generation without its coverage fact still reconstructs from the original signed canonical events", async () => {
  await using f = await signedFixture(128, 0)
  const preparation = [...Projection.generationPrefix(f.sessionID, f.generation), "preparation-v3"]
  await f.run(async () => {
    expect(
      await Storage.count({
        prefix: Keys.sharedEvents(f.sessionID, f.generation),
      }),
    ).toBe(f.watermark)
    expect(
      await Storage.query({
        prefix: Projection.root(f.sessionID, f.generation),
        limit: 1,
      }),
    ).toHaveLength(1)
    await Storage.remove(preparation)
    expect(await Storage.readMany([preparation])).toEqual([undefined])
  })
  using replay = observeReplay(f.sessionID, f.generation)
  const snapshot = (
    await f.owner.orgSessionSync.snapshot({ sessionID: f.sessionID, limit: 50 }, { throwOnError: true })
  ).data
  const messages = (
    await f.owner.orgSessionSync.messages({ sessionID: f.sessionID, limit: 50, latest: true }, { throwOnError: true })
  ).data
  expect(snapshot.items).toHaveLength(50)
  expect(messages.items).toHaveLength(50)
  expect(snapshot.watermark).toBe(f.watermark)
  expect(messages.watermark).toBe(f.watermark)
  expect(replay.pages()).toBeGreaterThanOrEqual(2)
  expect(replay.rows()).toBe(f.watermark)
  const pages = replay.pages()
  await f.owner.orgSessionSync.snapshot({ sessionID: f.sessionID, limit: 50 }, { throwOnError: true })
  expect(replay.pages()).toBe(pages)
}, 30_000)

for (const endpoint of ["events", "snapshot", "search"] as const) {
  test(`shared numeric URL ${endpoint} revisions accept generated SDK requests and reject malformed values`, async () => {
    await using f = await signedFixture(2, 0)
    if (endpoint === "events") {
      const checkpoint = (
        await f.owner.orgSessionSync.events(
          { sessionID: f.sessionID, limit: 1, cursor: f.watermark },
          { throwOnError: true },
        )
      ).data
      expect(checkpoint.items).toEqual([])
      expect(checkpoint.nextSeq).toBe(f.watermark + 1)
      await f.appendMessage()
      const tail = (
        await f.owner.orgSessionSync.events(
          { sessionID: f.sessionID, limit: 1, cursor: f.watermark },
          { throwOnError: true },
        )
      ).data
      expect(tail.items).toHaveLength(1)
      expect(tail.items[0]).toMatchObject({ type: "message", messageID: "later-message", sequence: f.watermark + 1 })
    } else if (endpoint === "snapshot") {
      const checkpoint = (
        await f.owner.orgSessionSync.snapshot(
          { sessionID: f.sessionID, limit: 50, watermark: f.watermark },
          { throwOnError: true },
        )
      ).data
      expect(checkpoint.watermark).toBe(f.watermark)
      expect(checkpoint.items).toHaveLength(f.watermark)
      await f.appendMessage()
      const fixed = (
        await f.owner.orgSessionSync.snapshot(
          { sessionID: f.sessionID, limit: 50, watermark: checkpoint.watermark },
          { throwOnError: true },
        )
      ).data
      expect(fixed.watermark).toBe(checkpoint.watermark)
      expect(fixed.items).toHaveLength(checkpoint.items.length)
      expect(fixed.items.every((event) => event.sequence <= checkpoint.watermark)).toBe(true)
    } else {
      const first = (
        await f.owner.orgSessionSync.search({ sessionID: f.sessionID, q: "Message", limit: 1 }, { throwOnError: true })
      ).data
      expect(first.items).toHaveLength(1)
      const cursor = first.cursor
      if (cursor === undefined) throw new Error("The original shared search did not retain its next sequence")
      const next = (
        await f.owner.orgSessionSync.search(
          { sessionID: f.sessionID, q: "Message", limit: 1, cursor },
          { throwOnError: true },
        )
      ).data
      expect(next.items).toHaveLength(1)
      expect(next.items[0]!.sequence).toBeGreaterThan(cursor)
      expect(next.items[0]!.id).toBe("message-0001")
    }
    for (const value of ["NaN", "Infinity", "0.5", "-1", "9007199254740992", "not-a-revision"]) {
      const response = await f.invalidQuery(endpoint, value)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: "INVALID_REQUEST",
        outcome: "not_dispatched",
        retryable: false,
      })
    }
  }, 30_000)
}
