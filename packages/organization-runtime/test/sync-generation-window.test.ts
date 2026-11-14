import { expect, spyOn, test } from "bun:test"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { prepareSessionMigrations } from "@ericsanchezok/synergy-harness/migration"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { openMemberRuntime } from "../src/runtime"
import { OrganizationSyncPath as Keys } from "../src/storage/path"
import { fixture } from "./support/organization"

async function until<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean) {
  const end = Date.now() + 15000
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    if (Date.now() > end) throw new Error(`${label}: ${JSON.stringify(value)}`)
    await Bun.sleep(25)
  }
}

test("a real enrolled native exporter reuses pending projections and regenerates acknowledged history with bounded write windows", async () => {
  await using resources = testResources()
  const service = await fixture()
  resources.defer("sync generation Service", () => service[Symbol.asyncDispose]())
  const options = { headers: service.headers, throwOnError: true as const }
  const home = await prepareMemberHome({
    baseDirectory: path.join(service.root, "members"),
    identity: service.identity,
    origin: service.origin,
  })
  const registration = await enrollMemberRuntime({
    home: home.home,
    identity: home.identity,
    ca: service.ca,
    ticket: await service.ticket(home.identity.deviceID, home.publicKey),
  })
  let online = false
  let sessionID = ""
  const firstBatches = new Map<number, Protocol.SyncBatch["batch"]>()
  const sockets = new Set<unknown>()
  service.interceptFrames((socket, raw) => {
    const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type === "handshake" && frame.proof.handshake.runtimeID === registration.runtimeID) sockets.add(socket)
    if (frame.type === "heartbeat" && sockets.has(socket)) online = true
    if (
      frame.type === "sync-batch" &&
      frame.batch.sessionID === sessionID &&
      !firstBatches.has(frame.batch.shareGeneration)
    )
      firstBatches.set(frame.batch.shareGeneration, frame.batch)
    return false
  })
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  const runtime = await openMemberRuntime({
    home: home.home,
    identity: home.identity,
    ca: service.ca,
    listen: { port, token: randomBytes(32).toString("hex") },
  })
  resources.defer("sync generation native Runtime", () => runtime.close())
  await until("actual Runtime heartbeat not observed", async () => online, Boolean)
  const project = (
    await service.client.orgProjects.create({ orgProjectCreate: { name: "Native generation windows" } }, options)
  ).data
  sessionID = (
    await service.client.orgSessions.create(
      {
        orgCommandCreateRequest: {
          schemaVersion: 1,
          orgID: home.identity.orgID,
          projectID: project.projectID,
          runtimeID: registration.runtimeID,
          requestID: "window-create",
          creation: { operation: "create", title: "Retained native generation" },
        },
      },
      options,
    )
  ).data.effect.sessionID
  const messages: string[] = []
  await runtime.run(async () => {
    const session = await Session.get(sessionID)
    await ScopeContext.provide({
      scope: session.scope,
      workspace: session.workspace,
      fn: async () => {
        for (let offset = 0; offset < 512; offset += 64)
          await Storage.transaction(async () => {
            for (let index = offset; index < offset + 64; index++) {
              const id = Identifier.ascending("message")
              messages.push(id)
              await Session.updateMessage({
                id,
                sessionID,
                role: "user",
                agent: "general",
                model: { providerID: "fixture", modelID: "native-window" },
                time: { created: index + 1 },
              })
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID,
                messageID: id,
                type: "text",
                text: `Native generation ${index}`,
              })
            }
          })
        await Session.flushPartWrites(sessionID)
        await prepareSessionMigrations({ scopeID: session.scope.id, sessionID })
      },
    })
  })
  const projectionCount = 1 + 2 * messages.length
  await until(
    "actual live projections did not settle before sharing",
    () => runtime.run(() => Storage.count({ prefix: Keys.projections(home.identity.orgID, sessionID) })),
    (count) => count === projectionCount,
  )
  const store = await runtime.run(async () => Storage.current().store)
  using writes = spyOn(store, "transaction")
  const budget = Math.ceil(projectionCount / 128) + 8
  async function drained() {
    return until(
      "actual exported drafts did not drain",
      () =>
        runtime.run(async () => {
          const [batch] = await Storage.readMany([Keys.batch(home.identity.orgID, sessionID)])
          return {
            drafts: await Storage.count({ prefix: Keys.drafts(home.identity.orgID, sessionID) }),
            batch: Boolean(batch),
          }
        }),
      (state) => state.drafts === 0 && !state.batch,
    )
  }
  async function verifySharedHistory() {
    let cursor: string | undefined
    let count = 0
    const received = new Set<string>()
    do {
      const page = (await service.client.orgSessionSync.messages({ sessionID, limit: 64, cursor }, options)).data
      expect(page.items.length).toBeLessThanOrEqual(64)
      for (const item of page.items) {
        received.add(item.messageID)
        count++
      }
      cursor = page.cursor
    } while (cursor)
    expect(count).toBe(messages.length)
    expect([...received].sort()).toEqual(messages.slice().sort())
  }
  const shared = (
    await service.client.orgSessions.share({ sessionID, orgShareChange: { expectedShareGeneration: 0 } }, options)
  ).data
  const first = await until(
    "first actual generation batch was not dispatched",
    async () => firstBatches.get(shared.shareGeneration),
    (batch) => Boolean(batch),
  )
  expect(writes.mock.calls.length).toBeLessThanOrEqual(budget)
  expect(first!.events[0]).toMatchObject({ type: "session", session: { sessionID } })
  expect(first!.events.length).toBeLessThanOrEqual(256)
  await drained()
  await verifySharedHistory()
  const hidden = (
    await service.client.orgSessions.unshare(
      { sessionID, orgShareChange: { expectedShareGeneration: shared.shareGeneration } },
      options,
    )
  ).data
  writes.mockClear()
  const reshared = (
    await service.client.orgSessions.share(
      { sessionID, orgShareChange: { expectedShareGeneration: hidden.shareGeneration } },
      options,
    )
  ).data
  expect(reshared.shareGeneration).toBeGreaterThan(shared.shareGeneration)
  await until(
    "new original generation was not reconstructed",
    async () => firstBatches.get(reshared.shareGeneration),
    (batch) => Boolean(batch),
  )
  expect(writes.mock.calls.length).toBeLessThanOrEqual(budget)
  await drained()
  await verifySharedHistory()
}, 45000)
