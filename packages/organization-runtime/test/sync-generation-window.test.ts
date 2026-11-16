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
import { observeSyncWindow } from "./support/sync-window-observation"

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
  const service = await fixture({ connections: { heartbeatMs: 25 } })
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
  using diagnostic = observeSyncWindow("generation", () => messages.length)
  const store = await runtime.run(async () => Storage.current().store)
  const transaction = store.transaction.bind(store)
  using writes = spyOn(store, "transaction").mockImplementation(
    <T>(body: Parameters<typeof store.transaction<T>>[0], options?: Parameters<typeof store.transaction<T>>[1]) =>
      transaction(async (tx) => {
        diagnostic.transaction(tx)
        return body(tx)
      }, options),
  )
  async function sample() {
    diagnostic.queue(
      await runtime.run(async () => ({
        projections: await Storage.count({ prefix: Keys.projections(home.identity.orgID, sessionID) }),
        drafts: await Storage.count({ prefix: Keys.drafts(home.identity.orgID, sessionID) }),
        ordered: await Storage.count({ prefix: Keys.orderedDrafts(home.identity.orgID, sessionID) }),
        nativeDeliveriesInStore: await Storage.count({ prefix: ["event_delivery", "organization-native-sync"] }),
        pendingBatches: Number((await Storage.readMany([Keys.batch(home.identity.orgID, sessionID)]))[0] !== undefined),
      })),
    )
  }
  diagnostic.stage("native-producer")
  await runtime.run(async () => {
    const session = await Session.get(sessionID)
    await ScopeContext.provide({
      scope: session.scope,
      workspace: session.workspace,
      fn: async () => {
        for (let offset = 0; offset < 512; offset += 64)
          await Storage.transaction(async (tx) => {
            diagnostic.nativeTransaction(tx)
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
        diagnostic.stage("part-flush")
        await Session.flushPartWrites(sessionID)
        diagnostic.stage("native-migrations")
        await prepareSessionMigrations({ scopeID: session.scope.id, sessionID })
      },
    })
  })
  diagnostic.stage("projection-drain")
  const projectionCount = 1 + 2 * messages.length
  await sample()
  await until(
    "actual live projections did not settle before sharing",
    async () => {
      const count = await runtime.run(() => Storage.count({ prefix: Keys.projections(home.identity.orgID, sessionID) }))
      diagnostic.queue({ projections: count })
      return count
    },
    (count) => count === projectionCount,
  )
  writes.mockClear()
  const budget = Math.ceil(projectionCount / 128) + 8
  async function drained() {
    return until(
      "actual exported drafts did not drain",
      () =>
        runtime.run(async () => {
          const [batch] = await Storage.readMany([Keys.batch(home.identity.orgID, sessionID)])
          const state = {
            drafts: await Storage.count({ prefix: Keys.drafts(home.identity.orgID, sessionID) }),
            batch: Boolean(batch),
          }
          diagnostic.queue({ drafts: state.drafts, pendingBatches: Number(state.batch) })
          return state
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
  diagnostic.stage("first-share")
  const shared = (
    await service.client.orgSessions.share({ sessionID, orgShareChange: { expectedShareGeneration: 0 } }, options)
  ).data
  diagnostic.stage("first-batch")
  const first = await until(
    "first actual generation batch was not dispatched",
    async () => firstBatches.get(shared.shareGeneration),
    (batch) => Boolean(batch),
  )
  expect(writes.mock.calls.length).toBeLessThanOrEqual(budget)
  await sample()
  expect(first!.events[0]).toMatchObject({ type: "session", session: { sessionID } })
  expect(first!.events.length).toBeLessThanOrEqual(256)
  diagnostic.stage("first-drain")
  await drained()
  diagnostic.stage("first-history")
  await verifySharedHistory()
  diagnostic.stage("unshare")
  const hidden = (
    await service.client.orgSessions.unshare(
      { sessionID, orgShareChange: { expectedShareGeneration: shared.shareGeneration } },
      options,
    )
  ).data
  writes.mockClear()
  diagnostic.stage("reshare")
  const reshared = (
    await service.client.orgSessions.share(
      { sessionID, orgShareChange: { expectedShareGeneration: hidden.shareGeneration } },
      options,
    )
  ).data
  expect(reshared.shareGeneration).toBeGreaterThan(shared.shareGeneration)
  diagnostic.stage("second-batch")
  await until(
    "new original generation was not reconstructed",
    async () => firstBatches.get(reshared.shareGeneration),
    (batch) => Boolean(batch),
  )
  expect(writes.mock.calls.length).toBeLessThanOrEqual(budget)
  diagnostic.stage("second-drain")
  await drained()
  diagnostic.stage("second-history")
  await verifySharedHistory()
  diagnostic.stage("completed")
}, 90000)
