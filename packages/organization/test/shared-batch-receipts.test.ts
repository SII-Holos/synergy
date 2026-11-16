import { expect, test } from "bun:test"
import {
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { digest } from "../src/auth/secret"
import type { RuntimeSocket } from "../src/runtime-connection"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationRecord as Record } from "../src/storage/records"
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

async function signedFixture(syncVersion: 1 | 2 = 2) {
  const resources = testResources()
  try {
    const f = await fixture()
    resources.defer("receipt Service", () => f[Symbol.asyncDispose]())
    await f.initialize()
    const server = Bun.serve<RuntimeSocket>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: f.service.fetch,
      websocket: f.service.websocket,
    })
    resources.defer("receipt listener", async () => {
      await server.stop(true)
    })
    const client = createOrganizationClient({
      baseUrl: server.url.toString(),
      headers: { origin: "https://organization.example" },
    })
    const login = await client.orgAuth.login(
      { orgLoginInput: { loginName: "owner", password } },
      { throwOnError: true },
    )
    const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
    if (!cookie) throw new Error("Original receipt owner has no actual login cookie")
    const token = Identity.Token.parse(cookie.slice(cookie.indexOf("=") + 1))
    const owner = createOrganizationClient({
      baseUrl: server.url.toString(),
      headers: {
        origin: "https://organization.example",
        cookie,
        "x-csrf-token": login.data.csrfToken,
      },
    })
    const project = (
      await owner.orgProjects.create(
        { orgProjectCreate: { name: "Exact native batch receipts" } },
        { throwOnError: true },
      )
    ).data
    const key = await keys()
    const ticket = (
      await owner.orgRuntime.registerMember(
        {
          orgMemberRuntimeRegistration: {
            deviceID: "exact-batch",
            publicKey: key.publicKey,
          },
        },
        { throwOnError: true },
      )
    ).data
    const runtime = (
      await owner.orgRuntime.consumeTicket(
        { orgRuntimeConsumeTicket: await proof(ticket, key.privateKey) },
        { throwOnError: true },
      )
    ).data
    const transport = await peer(server.url)
    resources.defer("receipt native socket", () => transport[Symbol.dispose]())
    const signed = await connection(runtime, key.privateKey, 1)
    signed.proof.handshake.capabilities.push("sync")
    signed.proof.handshake.schemas.sync = syncVersion
    signed.signature = await Runtime.sign(signed.proof, key.privateKey)
    expect(await transport.exchange(signed)).toMatchObject({
      type: "handshake",
      runtimeID: runtime.runtimeID,
      connectionEpoch: 1,
    })
    const session = await f.service.maintenance.run(() =>
      Directory.reservePrivate(
        { token, csrf: login.data.csrfToken },
        {
          sessionID: "exact-batch-session",
          projectID: project.projectID,
          runtimeID: runtime.runtimeID,
        },
      ),
    )
    const share = (
      await owner.orgSessions.share(
        { sessionID: session.sessionID, orgShareChange: { expectedShareGeneration: 0 } },
        { throwOnError: true },
      )
    ).data
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
    const original = Sync.Batch.parse({
      schemaVersion: 1,
      sessionID: session.sessionID,
      projectID: session.projectID,
      bindingEpoch: session.bindingEpoch,
      shareGeneration: share.shareGeneration,
      firstSeq: 1,
      lastSeq: 1,
      payloadHash: digest(JSON.stringify({ firstSeq: 1, lastSeq: 1, events })),
      events,
    })
    expect(
      await transport.exchange({
        type: "sync-batch",
        connectionEpoch: 1,
        exchangeID: "original-batch",
        batch: original,
      }),
    ).toMatchObject({ type: "sync-ack", exchangeID: "original-batch", ack: { nextSeq: 2, syncState: "synced" } })
    return {
      original,
      snapshot: () =>
        owner.orgSessionSync.snapshot({ sessionID: session.sessionID, limit: 50 }, { throwOnError: true }),
      exchange: (query: unknown) =>
        transport.exchange({ type: "sync-batch-receipt", connectionEpoch: 1, exchangeID: crypto.randomUUID(), query }),
      marker: () =>
        f.service.maintenance.run(() =>
          Record.read(
            Record.SharedBatch,
            Keys.sharedBatch(session.sessionID, share.shareGeneration, original.firstSeq),
          ),
        ),
      [Symbol.asyncDispose]: resources.close,
    }
  } catch (error) {
    try {
      await resources.close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Original signed receipt setup and cleanup failed")
    }
    throw error
  }
}

function identity(batch: Sync.Batch) {
  const { sessionID, projectID, bindingEpoch, shareGeneration, firstSeq, lastSeq, payloadHash } = batch
  return { sessionID, projectID, bindingEpoch, shareGeneration, firstSeq, lastSeq, payloadHash }
}

test("the original signed Runtime reads an exact committed batch receipt without guessing from nextSeq", async () => {
  await using f = await signedFixture()
  const original = identity(f.original)
  const marker = await f.marker()
  expect(marker).toMatchObject(original)
  if (!marker) throw new Error("Original Service marker is absent after the real signed batch")
  const before = structuredClone(marker)
  const reply = await f.exchange({ batch: original })
  expect(reply).toMatchObject({
    type: "sync-batch-receipt",
    receipt: { state: "committed", batch: original, committedAt: marker.committedAt },
  })
  expect(await f.marker()).toEqual(before)
  const transcript = await f.snapshot()
  expect(transcript.data.watermark).toBe(f.original.lastSeq)
}, 15000)

test("exact receipt lookup conflicts on the original marker tuple and leaves legacy sync one ordinary", async () => {
  for (const change of ["hash", "range", "epoch", "project"] as const) {
    await using f = await signedFixture()
    const original = identity(f.original)
    const changed = {
      ...original,
      ...(change === "hash" ? { payloadHash: "f".repeat(64) } : {}),
      ...(change === "range" ? { lastSeq: original.lastSeq + 1 } : {}),
      ...(change === "epoch" ? { bindingEpoch: original.bindingEpoch + 1 } : {}),
      ...(change === "project" ? { projectID: "another-project" } : {}),
    }
    const reply = await f.exchange({ batch: changed })
    expect(reply).toMatchObject({ type: "error" })
    expect(await f.marker()).toMatchObject(original)
  }
  await using legacy = await signedFixture(1)
  const reply = await legacy.exchange({ batch: identity(legacy.original) })
  expect(reply).toMatchObject({ type: "error", error: { code: "PROTOCOL_MISMATCH" } })
  expect(await legacy.marker()).toMatchObject(identity(legacy.original))
}, 20000)
