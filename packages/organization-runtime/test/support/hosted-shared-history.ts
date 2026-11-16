import { expect, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import {
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationSyncPath as NativeKeys } from "../../src/storage/path"
import { State } from "../../src/sync-outbox"
import { OrganizationRecord as Record } from "../../../organization/src/storage/records"
import { OrganizationStoragePath as ServiceKeys } from "../../../organization/src/storage/path"
import { OrganizationSharedProjection as Projection } from "../../../organization/src/shared-projection"
import { OrganizationSharedTasks as Tasks } from "../../../organization/src/shared-tasks"
import type { completedHostedTask } from "./hosted-task"
import type { fixture } from "./organization"

type ServiceFixture = Awaited<ReturnType<typeof fixture>>
type Runner = { run<T>(body: () => Promise<T>): Promise<T> }
type Selected = { service: ServiceFixture; registration: { runtimeID: string }; runtime: Runner }
type Task = Awaited<ReturnType<typeof completedHostedTask>>
type NativeBatch = { exchangeID: string; epoch: number; identity: Sync.BatchIdentity; dataHash: string }

async function until<T>(stage: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 4000
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`Actual Hosted sharing ${stage} did not settle`)
    await Bun.sleep(5)
  }
}

async function nativeDataHash(runtime: Runner, task: Task) {
  return runtime.run(async () => {
    const hash = createHash("sha256")
    for await (const message of MessageV2.stream({ scopeID: task.info.scope.id, sessionID: task.sessionID }))
      hash.update(JSON.stringify(message) + "\n")
    const owner = { kind: "session" as const, scopeID: task.info.scope.id, sessionID: task.sessionID }
    hash.update(
      JSON.stringify({
        run: await RolloutLedger.getRun(owner, task.nativeRelease.rootID),
        calls: await RolloutLedger.calls(owner, task.nativeRelease.rootID),
        segments: await RolloutLedger.segments(owner, task.nativeRelease.rootID),
        tools: await RolloutLedger.tools(owner, task.nativeRelease.rootID),
      }) + "\n",
    )
    return hash.digest("hex")
  })
}

async function retained(service: ServiceFixture["service"], sessionID: string, generation: number) {
  return service.maintenance.run(() =>
    Storage.snapshot(async () => {
      const families = [
        ["events", ServiceKeys.sharedEvents(sessionID, generation)],
        ["sessions", ServiceKeys.sharedSessions(sessionID, generation)],
        ["batches", ServiceKeys.sharedBatch(sessionID, generation, 1).slice(0, -1)],
        ["transcript", Projection.generationPrefix(sessionID, generation)],
        ["tasks", Tasks.generationPrefix(sessionID, generation)],
        ["blobs", ServiceKeys.sharedBlobs(sessionID, generation)],
      ] as const
      const result: Array<{ family: string; count: number; dataHash: string }> = []
      for (const [family, prefix] of families) {
        const hash = createHash("sha256")
        let count = 0
        for await (const row of Storage.records({ prefix: [...prefix], limit: 128 })) {
          hash.update(JSON.stringify([row.key, row.value]) + "\n")
          count++
        }
        result.push({ family, count, dataHash: hash.digest("hex") })
      }
      return result
    }),
  )
}

export async function shareAckUnshareHostedTask(selected: Selected, task: Task) {
  const service = selected.service
  const options = { headers: service.headers, throwOnError: true as const }
  const baseline = task.calls.length
  const sourceHash = await nativeDataHash(selected.runtime, task)
  expect(await selected.runtime.run(async () => SessionManager.isRunning(task.sessionID))).toBe(false)
  const initial = (await service.client.orgSessions.shareState({ sessionID: task.sessionID }, options)).data
  expect(initial).toMatchObject({ shareState: "private", shareGeneration: 0, nextSeq: 1 })
  let lastBatch: NativeBatch | undefined
  let acknowledged: { batch: NativeBatch; ack: Sync.Ack; sendResult: number } | undefined
  let observedBatches = 0
  const sockets = new WeakSet<object>()
  const restoreSend: Array<() => void> = []
  service.interceptFrames((socket, raw) => {
    if (socket.data.handshake?.runtimeID !== selected.registration.runtimeID) return false
    const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type !== "sync-batch" || frame.batch.sessionID !== task.sessionID) return false
    observedBatches++
    const batch = frame.batch
    const dataHash = createHash("sha256")
      .update(JSON.stringify({ firstSeq: batch.firstSeq, lastSeq: batch.lastSeq, events: batch.events }))
      .digest("hex")
    lastBatch = {
      exchangeID: frame.exchangeID,
      epoch: frame.connectionEpoch,
      dataHash,
      identity: Sync.BatchIdentity.parse({
        sessionID: batch.sessionID,
        projectID: batch.projectID,
        bindingEpoch: batch.bindingEpoch,
        shareGeneration: batch.shareGeneration,
        firstSeq: batch.firstSeq,
        lastSeq: batch.lastSeq,
        payloadHash: batch.payloadHash,
      }),
    }
    if (sockets.has(socket)) return false
    sockets.add(socket)
    const send = socket.send.bind(socket)
    const observed = spyOn(socket, "send").mockImplementation((data, compress) => {
      const result = send(data, compress)
      if (typeof data !== "string") return result
      let response: ReturnType<typeof Runtime.ServerFrame.safeParse>
      try {
        response = Runtime.ServerFrame.safeParse(JSON.parse(data))
      } catch {
        return result
      }
      const original = lastBatch
      if (
        response.success &&
        response.data.type === "sync-ack" &&
        original &&
        response.data.exchangeID === original.exchangeID &&
        response.data.connectionEpoch === original.epoch
      )
        acknowledged = { batch: original, ack: response.data.ack, sendResult: result }
      return result
    })
    restoreSend.push(() => observed.mockRestore())
    return false
  })
  try {
    const shared = (
      await service.client.orgSessions.share(
        { sessionID: task.sessionID, orgShareChange: { expectedShareGeneration: initial.shareGeneration } },
        options,
      )
    ).data
    expect(shared.shareState).toBe("shared")
    expect(shared.shareGeneration).toBe(initial.shareGeneration + 1)
    const fixed = await until("real WSS ACK and native outbox drainage", async () => {
      const share = (await service.client.orgSessions.shareState({ sessionID: task.sessionID }, options)).data
      const delivered = acknowledged
      if (
        !delivered ||
        share.shareGeneration !== shared.shareGeneration ||
        share.syncState !== "synced" ||
        share.nextSeq <= 1 ||
        delivered.ack.sessionID !== task.sessionID ||
        delivered.ack.bindingEpoch !== share.bindingEpoch ||
        delivered.ack.shareGeneration !== share.shareGeneration ||
        delivered.ack.syncState !== "synced" ||
        delivered.ack.nextSeq !== share.nextSeq ||
        delivered.batch.identity.lastSeq + 1 !== share.nextSeq
      )
        return
      const native = await selected.runtime.run(async () => {
        const [state, pending] = await Storage.readMany([
          NativeKeys.state(task.target.orgID, task.sessionID),
          NativeKeys.batch(task.target.orgID, task.sessionID),
        ])
        return {
          state: State.safeParse(state),
          pending,
          drafts: (await Storage.queryKeys({ prefix: NativeKeys.drafts(task.target.orgID, task.sessionID), limit: 1 }))
            .length,
          ordered: (
            await Storage.queryKeys({ prefix: NativeKeys.orderedDrafts(task.target.orgID, task.sessionID), limit: 1 })
          ).length,
          deliveries: await Storage.count({ prefix: ["event_delivery", "organization-native-sync"] }),
        }
      })
      if (
        !native.state.success ||
        native.state.data.shareGeneration !== share.shareGeneration ||
        native.state.data.projectionVersion !== 2 ||
        native.state.data.syncState !== "synced" ||
        native.pending !== undefined ||
        native.drafts ||
        native.ordered ||
        native.deliveries
      )
        return
      const marker = await service.service.maintenance.run(() =>
        Record.read(
          Record.SharedBatch,
          ServiceKeys.sharedBatch(task.sessionID, share.shareGeneration, delivered.batch.identity.firstSeq),
        ),
      )
      if (!marker) return
      expect(marker).toMatchObject(delivered.batch.identity)
      expect(delivered.batch.dataHash).toBe(delivered.batch.identity.payloadHash)
      return { share, delivered, native: native.state.data, marker }
    })
    const watermark = fixed.share.nextSeq - 1
    const snapshotHash = createHash("sha256")
    let cursor: string | undefined
    let messages = 0
    let items = 0
    do {
      const previous = cursor
      const page = (
        await service.client.orgSessionSync.snapshot(
          { sessionID: task.sessionID, watermark, cursor, limit: 128 },
          options,
        )
      ).data
      expect(page).toMatchObject({ sessionID: task.sessionID, shareGeneration: shared.shareGeneration, watermark })
      for (const event of page.items) {
        snapshotHash.update(JSON.stringify(event) + "\n")
        items++
        if (event.type === "message" && event.messageID === task.accepted.effect.messageID) messages++
      }
      cursor = page.cursor
      if (cursor && cursor === previous) throw new Error("Original fixed shared snapshot did not advance its cursor")
    } while (cursor)
    expect(messages).toBe(1)
    expect(items).toBeGreaterThan(0)
    const sharedDataHash = snapshotHash.digest("hex")
    const history = await retained(service.service, task.sessionID, shared.shareGeneration)
    for (const family of ["events", "sessions", "batches", "transcript"])
      expect(history.find((value) => value.family === family)!.count).toBeGreaterThan(0)
    const unshared = (
      await service.client.orgSessions.unshare(
        { sessionID: task.sessionID, orgShareChange: { expectedShareGeneration: shared.shareGeneration } },
        options,
      )
    ).data
    expect(unshared).toMatchObject({
      shareState: "private",
      shareGeneration: shared.shareGeneration + 1,
      bindingEpoch: shared.bindingEpoch,
      nextSeq: 1,
      syncState: "blocked",
    })
    expect(await retained(service.service, task.sessionID, shared.shareGeneration)).toEqual(history)
    const privateState = await service.service.maintenance.run(() =>
      Record.read(Record.SharedState, ServiceKeys.sharedState(task.sessionID)),
    )
    expect(privateState).toMatchObject({
      shareGeneration: unshared.shareGeneration,
      bindingEpoch: unshared.bindingEpoch,
      nextSeq: 1,
      syncState: "blocked",
    })
    expect(await nativeDataHash(selected.runtime, task)).toBe(sourceHash)
    expect(task.calls).toHaveLength(baseline)
    return {
      shared,
      unshared,
      watermark,
      sharedDataHash,
      nativeDataHash: sourceHash,
      snapshotItems: items,
      acknowledgement: fixed.delivered,
      committedBatch: fixed.marker,
      nativeCheckpoint: fixed.native,
      retained: history,
      observedBatches,
      async verifyService(current: ServiceFixture["service"]) {
        expect(await retained(current, task.sessionID, shared.shareGeneration)).toEqual(history)
        expect(
          await current.maintenance.run(() => Record.read(Record.SharedState, ServiceKeys.sharedState(task.sessionID))),
        ).toEqual(privateState)
        const session = await current.maintenance.run(() =>
          Record.read(Record.SessionDirectory, ServiceKeys.session(task.sessionID)),
        )
        expect(session).toMatchObject({
          sessionID: task.sessionID,
          shareState: "private",
          shareGeneration: unshared.shareGeneration,
          driverRuntimeID: selected.registration.runtimeID,
          bindingEpoch: unshared.bindingEpoch,
        })
        expect(task.calls).toHaveLength(baseline)
      },
      async verifyNative(current: Runner) {
        expect(await nativeDataHash(current, task)).toBe(sourceHash)
        expect(await current.run(async () => SessionManager.isRunning(task.sessionID))).toBe(false)
        expect(task.calls).toHaveLength(baseline)
      },
    }
  } finally {
    service.interceptFrames(undefined)
    for (const restore of restoreSend.toReversed()) restore()
  }
}
