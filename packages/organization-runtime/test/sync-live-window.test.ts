import { expect, spyOn, test } from "bun:test"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { prepareSessionMigrations } from "@ericsanchezok/synergy-harness/migration"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { openMemberRuntime } from "../src/runtime"
import { OrganizationSyncPath as Keys } from "../src/storage/path"
import { State } from "../src/sync-outbox"
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

test("a live native producer reaches its first shared batch through bounded exporter write windows", async () => {
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
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  })
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
          creation: {
            operation: "create",
            title: "Retained native generation",
          },
        },
      },
      options,
    )
  ).data.effect.sessionID
  const messages: string[] = []
  using diagnostic = observeSyncWindow("live", () => messages.length)
  const store = await runtime.run(async () => Storage.current().store)
  const sourceTransactions = new WeakSet<StoreTransaction>()
  let exporterTransactions = new WeakSet<StoreTransaction>()
  let exporterWriters = 0
  const transaction = store.transaction.bind(store)
  using writes = spyOn(store, "transaction").mockImplementation(
    <T>(body: Parameters<typeof store.transaction<T>>[0], options?: Parameters<typeof store.transaction<T>>[1]) =>
      transaction(async (tx) => {
        diagnostic.transaction(tx)
        sourceTransactions.add(tx)
        return body(tx)
      }, options),
  )
  const write = StoreTransaction.prototype.write
  using observedWrites = spyOn(StoreTransaction.prototype, "write").mockImplementation(function (
    this: StoreTransaction,
    key: string[],
    value: unknown,
    options?: { expectedRevision?: bigint },
  ) {
    if (
      sourceTransactions.has(this) &&
      key[0] === Keys.roots(home.identity.orgID)[0] &&
      !exporterTransactions.has(this)
    ) {
      exporterTransactions.add(this)
      exporterWriters++
    }
    return write.call(this, key, value, options)
  })
  const samples: Array<{
    stage: string
    writers: number
    exporterWriters: number
    projections: number
    drafts: number
    ordered: number
  }> = []
  async function sample(stage: string) {
    const state = await runtime.run(async () => ({
      nativeDeliveriesInStore: await Storage.count({ prefix: ["event_delivery", "organization-native-sync"] }),
      pendingBatches: Number((await Storage.readMany([Keys.batch(home.identity.orgID, sessionID)]))[0] !== undefined),
      projections: await Storage.count({
        prefix: Keys.projections(home.identity.orgID, sessionID),
      }),
      drafts: await Storage.count({
        prefix: Keys.drafts(home.identity.orgID, sessionID),
      }),
      ordered: await Storage.count({
        prefix: Keys.orderedDrafts(home.identity.orgID, sessionID),
      }),
    }))
    diagnostic.queue(state)
    const value = { stage, writers: writes.mock.calls.length, exporterWriters, ...state }
    samples.push(value)
    console.error("SYNC_LIVE_WINDOW", JSON.stringify(value))
    return value
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
        await prepareSessionMigrations({
          scopeID: session.scope.id,
          sessionID,
        })
      },
    })
  })
  diagnostic.stage("projection-drain")
  const projectionCount = 1 + 2 * messages.length
  await sample("native-producer-complete")
  const budget = Math.ceil(projectionCount / 128) * 2 + Math.ceil(messages.length / 64) + 16
  const generationBudget = Math.ceil(projectionCount / 128) + 8
  async function drained() {
    return until(
      "actual exported drafts did not drain",
      () =>
        runtime.run(async () => {
          const [batch] = await Storage.readMany([Keys.batch(home.identity.orgID, sessionID)])
          const state = {
            drafts: await Storage.count({
              prefix: Keys.drafts(home.identity.orgID, sessionID),
            }),
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
  await sample("first-shared-batch")
  expect(exporterWriters, JSON.stringify(samples)).toBeLessThanOrEqual(budget)
  expect(first!.events[0]).toMatchObject({
    type: "session",
    session: { sessionID },
  })
  expect(first!.events.length).toBeLessThanOrEqual(256)
  diagnostic.stage("first-drain")
  await drained()
  await sample("first-generation-drained")
  diagnostic.stage("first-history")
  await verifySharedHistory()
  diagnostic.stage("tail-native")
  const checkpoint = (await service.client.orgSessionSync.snapshot({ sessionID, limit: 50 }, options)).data
  const tailMessageID = Identifier.ascending("message")
  const tailPartID = Identifier.ascending("part")
  await runtime.run(async () => {
    const session = await Session.get(sessionID)
    await ScopeContext.provide({
      scope: session.scope,
      workspace: session.workspace,
      fn: () =>
        Storage.transaction(async () => {
          await Session.updateMessage({
            id: tailMessageID,
            sessionID,
            role: "user",
            agent: "general",
            model: { providerID: "fixture", modelID: "native-window" },
            time: { created: Date.now() },
          })
          await Session.updatePart({
            id: tailPartID,
            sessionID,
            messageID: tailMessageID,
            type: "text",
            text: "Original post-checkpoint native fact",
          })
        }),
    })
    await Session.flushPartWrites(sessionID)
  })
  messages.push(tailMessageID)
  diagnostic.stage("tail-events")
  try {
    const events = await until(
      "the resident exporter did not publish the original post-checkpoint native fact",
      async () =>
        (await service.client.orgSessionSync.events({ sessionID, limit: 50, cursor: checkpoint.watermark }, options))
          .data,
      (page) =>
        page.items.some((event) => event.type === "message" && event.messageID === tailMessageID) &&
        page.items.some((event) => event.type === "part" && event.partID === tailPartID),
    )
    expect(events.shareGeneration).toBe(shared.shareGeneration)
    expect(events.nextSeq).toBeGreaterThan(checkpoint.watermark + 1)
    await drained()
  } catch (error) {
    try {
      const native = await runtime.run(async () => {
        const [rawState, batch] = await Storage.readMany([
          Keys.state(home.identity.orgID, sessionID),
          Keys.batch(home.identity.orgID, sessionID),
        ])
        const state = State.safeParse(rawState)
        return {
          deliveries: await Storage.count({ prefix: ["event_delivery", "organization-native-sync"] }),
          drafts: await Storage.count({ prefix: Keys.drafts(home.identity.orgID, sessionID) }),
          ordered: await Storage.count({ prefix: Keys.orderedDrafts(home.identity.orgID, sessionID) }),
          batch: Boolean(batch),
          stateValid: state.success,
          syncState: state.success ? state.data.syncState : undefined,
          shareGeneration: state.success ? state.data.shareGeneration : undefined,
        }
      })
      console.error("SYNC_RESIDENT_POST_CHECKPOINT", JSON.stringify(native))
    } catch (diagnosticError) {
      console.error(
        "SYNC_RESIDENT_POST_CHECKPOINT_DIAGNOSTIC",
        diagnosticError instanceof Error ? diagnosticError.name : "unknown",
      )
    }
    throw error
  }
  diagnostic.stage("unshare")
  const hidden = (
    await service.client.orgSessions.unshare(
      {
        sessionID,
        orgShareChange: { expectedShareGeneration: shared.shareGeneration },
      },
      options,
    )
  ).data
  writes.mockClear()
  exporterTransactions = new WeakSet<StoreTransaction>()
  exporterWriters = 0
  diagnostic.stage("reshare")
  const reshared = (
    await service.client.orgSessions.share(
      {
        sessionID,
        orgShareChange: { expectedShareGeneration: hidden.shareGeneration },
      },
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
  await sample("reshared-batch")
  expect(exporterWriters, JSON.stringify(samples)).toBeLessThanOrEqual(generationBudget)
  diagnostic.stage("second-drain")
  await drained()
  await sample("second-generation-drained")
  diagnostic.stage("second-history")
  await verifySharedHistory()
  diagnostic.stage("completed")
}, 90000)
