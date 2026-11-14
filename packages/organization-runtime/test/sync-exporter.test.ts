import { expect, spyOn, test } from "bun:test"
import { z } from "zod"
import {
  OrganizationSessionProtocol as Sessions,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageMutationGuard } from "@ericsanchezok/synergy-harness/storage/mutation-guard"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { startMemberSyncExporter, drainMemberSync } from "../src/sync-exporter"
import type { MemberConnection } from "../src/connection"
import { prepareNativeSync, pumpNativeSync } from "../src/sync-native-source"
import { binding as nativeSyncBinding, Batch as StoredBatch } from "../src/sync-outbox"
import { registerSessionSchema } from "../src/session-schema"
import { OrganizationSyncPath as Keys } from "../src/storage/path"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { SessionTransferEpochs as Epochs } from "@ericsanchezok/synergy-harness/session/transfer"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"

const binding: Sessions.Binding = {
  schemaVersion: 1,
  orgID: "org-sync",
  projectID: "project-sync",
  creatorID: "creator-sync",
  driverRuntimeID: "runtime-sync",
  bindingEpoch: 1,
}

test("a surrendered source never dispatches its retained shared transcript queue", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const f = await fixture()
    await ScopeContext.provide({
      scope: f.scope,
      workspace: null,
      fn: async () => {
        await SessionLifecycle.pause({ sessionID: f.session.id, reason: "interrupted" })
        const source = {
          sessionID: f.session.id,
          scopeID: binding.projectID,
          handoffID: "sync-return",
          sourceID: binding.driverRuntimeID,
          targetID: "runtime-target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.freeze(source)
        await Epochs.seal(source, "a".repeat(64))
        await Epochs.surrender(source, "b".repeat(64))
        const remote = transport(f.session.id)
        let reads = 0
        const read = remote.connection.syncState
        remote.connection.syncState = async (...args) => {
          reads++
          return read(...args)
        }
        const exporter = startMemberSyncExporter({
          identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
          connection: remote.connection,
          signal: new AbortController().signal,
        })
        try {
          await exporter.flush()
          expect(reads).toBe(0)
          expect(remote.batches).toHaveLength(0)
          expect((await Session.get(f.session.id)).organization?.driverRuntimeID).toBe(binding.driverRuntimeID)
          expect((await Epochs.inspect(source)).phase).toBe("surrendered")
        } finally {
          await exporter.close()
        }
      },
    })
  })
})

test("source freeze drains an already accepted sync request before its final closure", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const f = await fixture()
    const remote = transport(f.session.id)
    const accepted = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const read = remote.connection.syncState
    remote.connection.syncState = async (...args) => {
      accepted.resolve()
      await released.promise
      return read(...args)
    }
    const exporter = startMemberSyncExporter({
      identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
      connection: remote.connection,
      signal: new AbortController().signal,
    })
    try {
      const flushing = exporter.flush()
      await accepted.promise
      await ScopeContext.provide({
        scope: f.scope,
        workspace: null,
        fn: async () => {
          await SessionLifecycle.pause({ sessionID: f.session.id, reason: "interrupted" })
          await Epochs.beginSource({
            sessionID: f.session.id,
            scopeID: binding.projectID,
            handoffID: "accepted-sync",
            sourceID: binding.driverRuntimeID,
            targetID: "runtime-target",
            fromEpoch: 1,
            toEpoch: 2,
          })
        },
      })
      let done = false
      const draining = drainMemberSync(f.session.id).then(() => {
        done = true
      })
      await Bun.sleep(10)
      expect(done).toBe(false)
      released.resolve()
      await draining
      await flushing
      expect(done).toBe(true)
      expect(remote.batches).toHaveLength(0)
    } finally {
      released.resolve()
      await exporter.close()
    }
  })
})

async function fixture() {
  const scope = await Scope.registerProject({
    type: "project",
    id: binding.projectID,
    local: null,
    time: { created: 1, updated: 1 },
  })
  const session = await ScopeContext.provide({
    scope,
    workspace: null,
    fn: () => Session.create({ organization: binding, workspaceID: null }),
  })
  await Storage.write(Keys.state(binding.orgID, session.id), {
    schemaVersion: 1,
    orgID: binding.orgID,
    sessionID: session.id,
    nextDraft: 1,
    syncState: "pending",
    updatedAt: 1,
  })
  await Storage.write(Keys.registeredRoot(binding.orgID, session.id), { sessionID: session.id })
  const info = MessageV2.User.parse({
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "user",
    time: { created: 2 },
    agent: "general",
    model: { providerID: "fixture", modelID: "model" },
  })
  await ScopeContext.provide({ scope, workspace: null, fn: () => Session.updateMessage(info) })
  const part = MessageV2.TextPart.parse({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID: info.id,
    type: "text",
    text: "Historical shared dialogue",
  })
  await ScopeContext.provide({ scope, workspace: null, fn: () => Session.updatePart(part) })
  return { session, info, part, scope }
}

function transport(sessionID: string, receive?: (batch: Sync.Batch) => Promise<void>) {
  const batches: Sync.Batch[] = []
  let nextSeq = 1
  const observations: Sync.StateObservation[] = []
  let syncState: Sync.Share["syncState"] = "pending"
  const connection: Pick<MemberConnection, "connected" | "sync" | "syncState" | "uploadBlob" | "observeSync"> = {
    connected: {
      type: "handshake",
      protocolVersion: 1,
      orgID: binding.orgID,
      deploymentIncarnation: "deployment-sync",
      runtimeID: binding.driverRuntimeID,
      connectionEpoch: 1,
      syncVersion: Sync.observationVersion,
      signingIdentity: {
        schemaVersion: 1,
        orgID: binding.orgID,
        deploymentIncarnation: "deployment-sync",
        keyID: "key-sync",
        publicKey: "a".repeat(64),
      },
      heartbeatMs: 10,
      offlineMs: 100,
    },
    async syncState() {
      return {
        sessionID,
        shareState: "shared",
        shareGeneration: 1,
        bindingEpoch: 1,
        nextSeq,
        syncState,
        updatedAt: 1,
      }
    },
    async observeSync(id, value) {
      const observation = Sync.StateObservation.parse(value)
      expect(id).toBe(sessionID)
      expect(observation).toMatchObject({ bindingEpoch: 1, shareGeneration: 1, nextSeq })
      observations.push(observation)
      syncState = observation.state
      return { sessionID, shareState: "shared", shareGeneration: 1, bindingEpoch: 1, nextSeq, syncState, updatedAt: 1 }
    },
    async sync(batch) {
      if (nextSeq === 1) expect(batch.events[0]).toMatchObject({ type: "session", session: { sessionID } })
      batches.push(batch)
      await receive?.(batch)
      nextSeq = batch.lastSeq + 1
      return { sessionID, shareGeneration: 1, bindingEpoch: 1, nextSeq, syncState: "synced" }
    },
    async uploadBlob() {
      throw new Error("This fixture does not publish blobs")
    },
  }
  return { connection, batches, observations }
}

test("the native exporter initializes a complete empty attachment before publishing its reference", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const f = await fixture()
    const artifact = await RolloutArtifact.writeText(
      { kind: "session", scopeID: f.scope.id, sessionID: f.session.id },
      "",
      "application/octet-stream",
    )
    const id = Identifier.ascending("part")
    await ScopeContext.provide({
      scope: f.scope,
      workspace: null,
      fn: () =>
        Session.updatePart({
          id,
          sessionID: f.session.id,
          messageID: f.info.id,
          type: "attachment",
          artifact,
          mime: "application/octet-stream",
          filename: "empty.bin",
          url: "attachment://empty",
        }),
    })
    const remote = transport(f.session.id)
    const uploads: Array<Parameters<MemberConnection["uploadBlob"]>[0]> = []
    remote.connection.uploadBlob = async (input) => {
      uploads.push(input)
      return Sync.BlobStatus.parse({
        sessionID: input.sessionID,
        shareGeneration: input.shareGeneration,
        hash: input.hash,
        bytes: 0,
        chunkBytes: 4 * 1024 * 1024,
        receivedBytes: 0,
        complete: true,
      })
    }
    const exporter = startMemberSyncExporter({
      identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
      connection: remote.connection,
      signal: new AbortController().signal,
    })
    try {
      await exporter.flush()
      expect(uploads).toHaveLength(1)
      expect(uploads[0]).toMatchObject({ offset: 0, totalBytes: 0, bytes: new Uint8Array(), hash: artifact.sha256 })
      expect(remote.batches.flatMap((batch) => batch.events)).toContainEqual(
        expect.objectContaining({ type: "attachment", attachmentID: id, bytes: 0, state: "available" }),
      )
    } finally {
      await exporter.close()
    }
  })
})

test("sharing after restart backfills canonical history before streaming live updates", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const f = await fixture()
    const remote = transport(f.session.id)
    const exporter = startMemberSyncExporter({
      identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
      connection: remote.connection,
      signal: new AbortController().signal,
    })
    try {
      await exporter.flush()
      const events = remote.batches.flatMap((batch) => batch.events)
      expect(events).toContainEqual(
        expect.objectContaining({ type: "message", messageID: f.info.id, model: f.info.model }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "part",
          partID: f.part.id,
          part: { type: "text", content: { kind: "inline", text: f.part.text }, origin: "user" },
        }),
      )
    } finally {
      await exporter.close()
    }
  })
})

test("an already-shared metadata-only checkpoint upgrades to complete canonical content", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const f = await fixture()
    await Storage.write(Keys.state(binding.orgID, f.session.id), {
      schemaVersion: 1,
      orgID: binding.orgID,
      sessionID: f.session.id,
      nextDraft: 1,
      shareGeneration: 1,
      syncState: "synced",
      updatedAt: 1,
    })
    const remote = transport(f.session.id)
    const exporter = startMemberSyncExporter({
      identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
      connection: remote.connection,
      signal: new AbortController().signal,
    })
    try {
      await exporter.flush()
      expect(remote.batches.flatMap((batch) => batch.events)).toContainEqual(
        expect.objectContaining({ type: "part", partID: f.part.id }),
      )
    } finally {
      await exporter.close()
    }
  })
})

test("closing the exporter waits for in-flight publication before releasing its owner", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const f = await fixture()
    const sent = Promise.withResolvers<void>()
    const acknowledge = Promise.withResolvers<void>()
    const remote = transport(f.session.id, async () => {
      sent.resolve()
      await acknowledge.promise
    })
    const exporter = startMemberSyncExporter({
      identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
      connection: remote.connection,
      signal: new AbortController().signal,
    })
    const work = exporter.flush()
    try {
      await sent.promise
      let released = false
      const closing = Promise.resolve(exporter.close()).then(() => {
        released = true
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(released).toBe(false)
      acknowledge.resolve()
      await closing
      expect(released).toBe(true)
      await ScopeContext.provide({
        scope: f.scope,
        workspace: null,
        fn: () => Session.updatePart({ ...f.part, text: "After close" }),
      })
      await exporter.flush()
      expect(remote.batches).toHaveLength(1)
    } finally {
      acknowledge.resolve()
      await work
      await exporter.close()
    }
  })
})

test("a native Part removal rolls back canonical history when its original sync delivery cannot persist", async () => {
  const full = Object.assign(new Error("Original native delivery write failed"), { code: "SQLITE_FULL" })
  let fail = false
  await using runtime = await testRuntime({
    register() {
      registerSessionSchema(binding)
      StorageMutationGuard.register("original-sync-delivery-failure", async (_tx, keys) => {
        if (fail && keys.some((key) => key[0] === "event_delivery")) throw full
      })
    },
  })
  await runtime.run(async () => {
    const f = await fixture()
    const retained = async () => {
      const records: Array<{ key: string[]; value: unknown }> = []
      for await (const row of Storage.records({ prefix: ["sessions", f.scope.id, f.session.id] }))
        records.push({ key: row.key, value: row.value })
      return records
    }
    const before = await retained()
    const pending = await Storage.current().store.pendingEvents()
    const deliveries = await Storage.query({ kind: "event_delivery" })
    const sequences = await Storage.query({ kind: "event_delivery_meta" })
    fail = true
    try {
      await expect(
        ScopeContext.provide({
          scope: f.scope,
          workspace: null,
          fn: () => Session.removePart({ sessionID: f.session.id, messageID: f.info.id, partID: f.part.id }),
        }),
      ).rejects.toBe(full)
    } finally {
      fail = false
    }
    expect(await retained()).toEqual(before)
    expect(await Storage.current().store.pendingEvents()).toEqual(pending)
    expect(deliveries.length).toBeGreaterThan(0)
    expect(await Storage.query({ kind: "event_delivery" })).toEqual(deliveries)
    expect(await Storage.query({ kind: "event_delivery_meta" })).toEqual(sequences)
    expect(
      await MessageV2.readPart({
        scopeID: f.scope.id,
        sessionID: f.session.id,
        messageID: f.info.id,
        partID: f.part.id,
      }),
    ).toMatchObject({ id: f.part.id, text: f.part.text })
  })
})

test("an offline native Part removal survives restart and a failed local outbox conversion", async () => {
  await using home = await tmpdir()
  let target: { sessionID: string; messageID: string; partID: string; scopeID: string }
  let deliveries: unknown[]
  {
    await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
    await runtime.run(async () => {
      const f = await fixture()
      target = { sessionID: f.session.id, messageID: f.info.id, partID: f.part.id, scopeID: f.scope.id }
      await ScopeContext.provide({
        scope: f.scope,
        workspace: null,
        fn: () => Session.removePart(target),
      })
      expect(await MessageV2.readPart(target)).toBeUndefined()
      const rows = await Storage.query<{ payload: unknown }>({ kind: "event_delivery" })
      const selected = rows.filter((row) => {
        const parsed = z
          .object({
            sessionID: z.string(),
            selector: z.object({ kind: z.string(), partID: z.string().optional(), removed: z.boolean().optional() }),
          })
          .safeParse(row.value.payload)
        return (
          parsed.success &&
          parsed.data.sessionID === target.sessionID &&
          parsed.data.selector.kind === "part" &&
          parsed.data.selector.partID === target.partID &&
          parsed.data.selector.removed
        )
      })
      expect(selected).toHaveLength(1)
      expect(selected[0]!.value.payload).toMatchObject({
        version: 1,
        scopeID: f.scope.id,
        rootSessionID: f.session.id,
        sessionID: f.session.id,
        binding,
      })
      expect(JSON.stringify(rows.map((row) => row.value))).not.toContain(f.part.text)
      deliveries = rows.map((row) => row.value)
    })
  }
  let fail = true
  const full = Object.assign(new Error("Original sync outbox write failed"), { code: "ENOSPC" })
  await using runtime = await testRuntime({
    home: home.path,
    register() {
      registerSessionSchema(binding)
      StorageMutationGuard.register("original-sync-outbox-failure", async (_tx, keys) => {
        if (fail && keys.some((key) => key[0] === "organization-sync" && key[4] === "drafts")) throw full
      })
    },
  })
  await runtime.run(async () => {
    expect(await MessageV2.readPart(target!)).toBeUndefined()
    expect((await Storage.query({ kind: "event_delivery" })).map((row) => row.value)).toEqual(deliveries!)
    const remote = transport(target!.sessionID)
    let shareReads = 0
    const syncState = remote.connection.syncState
    remote.connection.syncState = async (...args) => {
      shareReads++
      return syncState(...args)
    }
    const exporter = startMemberSyncExporter({
      identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
      connection: remote.connection,
      signal: new AbortController().signal,
    })
    try {
      await expect(exporter.flush()).rejects.toBe(full)
      expect(remote.batches).toEqual([])
      expect(shareReads).toBeGreaterThan(0)
      expect(remote.observations.at(-1)).toMatchObject({ state: "blocked", reason: "storage_full" })
      expect((await Storage.query({ kind: "event_delivery" })).map((row) => row.value)).toEqual(deliveries!)
      expect(await MessageV2.readPart(target!)).toBeUndefined()
    } finally {
      try {
        await RuntimeContext.exit(() => exporter.close())
      } catch (error) {
        if (error !== full && !(error instanceof AggregateError && error.errors.every((cause) => cause === full)))
          throw error
      }
    }
    expect((await Storage.query({ kind: "event_delivery" })).map((row) => row.value)).toEqual(deliveries!)
    fail = false
    const reopened = startMemberSyncExporter({
      identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
      connection: remote.connection,
      signal: new AbortController().signal,
    })
    try {
      await reopened.flush()
      const parts = remote.batches
        .flatMap((batch) => batch.events)
        .filter((event) => event.type === "part" && event.partID === target!.partID)
      expect(parts).toHaveLength(1)
      expect(parts[0]).toMatchObject({
        sessionID: target!.sessionID,
        messageID: target!.messageID,
        partID: target!.partID,
        removed: true,
      })
      expect(await Storage.query({ kind: "event_delivery" })).toEqual([])
      expect(remote.observations.at(-1)).toMatchObject({ state: "pending" })
      expect(await MessageV2.readPart(target!)).toBeUndefined()
    } finally {
      await reopened.close()
    }
  })
})

test.each(["close", "abort", "foreign-close"] as const)(
  "detached %s retains an accepted native Part removal for exporter restart without another publication",
  async (mode) => {
    await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
    await using foreign = mode === "foreign-close" ? await testRuntime() : undefined
    await runtime.run(async () => {
      const f = await fixture()
      const remote = transport(f.session.id)
      const controller = new AbortController()
      const exporter = startMemberSyncExporter({
        identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
        connection: remote.connection,
        signal: controller.signal,
      })
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const removal = Promise.withResolvers<void>()
      const stopRemoval = Bus.subscribeGlobal(MessageV2.Event.PartRemoved, (event) => {
        if (event.properties.sessionID === f.session.id && event.properties.partID === f.part.id) removal.resolve()
      })
      const heldPart = { ...f.part, id: Identifier.ascending("part"), text: "Accepted selector before removal" }
      const readPart = MessageV2.readPart
      using held = spyOn(MessageV2, "readPart").mockImplementation(async (input) => {
        if (input.sessionID === f.session.id && input.partID === heldPart.id) {
          entered.resolve()
          await release.promise
        }
        return readPart(input)
      })
      try {
        await exporter.flush()
        await ScopeContext.provide({ scope: f.scope, workspace: null, fn: () => Session.updatePart(heldPart) })
        await entered.promise
        await ScopeContext.provide({
          scope: f.scope,
          workspace: null,
          fn: () => Session.removePart({ sessionID: f.session.id, messageID: f.info.id, partID: f.part.id }),
        })
        await removal.promise
        const partKey = ["sessions", f.scope.id, f.session.id, "messages", f.info.id, "parts", f.part.id]
        expect((await Storage.readMany([partKey]))[0]).toBeUndefined()
        const publications = remote.batches.length
        if (mode === "abort")
          RuntimeContext.exit(() => controller.abort(new Error("Original export connection closed")))
        let closed = false
        const close = foreign
          ? () => foreign.run(() => exporter.close())
          : () => RuntimeContext.exit(() => exporter.close())
        const closing = close().then(() => {
          closed = true
        })
        await Promise.resolve()
        expect(closed).toBe(false)
        release.resolve()
        await closing
        expect(remote.batches.length).toBe(publications)
        const draftID = createHash("sha256")
          .update(JSON.stringify({ type: "part", sessionID: f.session.id, partID: f.part.id }))
          .digest("hex")
          .slice(0, 32)
        const [draft, projection] = await Storage.readMany<{ event: Sync.Event }>([
          Keys.draft(binding.orgID, f.session.id, draftID),
          Keys.projection(binding.orgID, f.session.id, draftID),
        ])
        expect(draft?.event).toMatchObject({
          type: "part",
          sessionID: f.session.id,
          messageID: f.info.id,
          partID: f.part.id,
          removed: true,
        })
        expect(projection?.event).toEqual(draft?.event)
        if (foreign)
          await foreign.run(async () => {
            expect(await Storage.query({ prefix: Keys.sessions(binding.orgID), limit: 1 })).toEqual([])
            expect(await Storage.query({ kind: "event_delivery", limit: 1 })).toEqual([])
          })
        const reopened = startMemberSyncExporter({
          identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
          connection: remote.connection,
          signal: new AbortController().signal,
        })
        try {
          await reopened.flush()
          const latest = remote.batches
            .flatMap((batch) => batch.events)
            .filter((event) => event.type === "part" && event.partID === f.part.id)
            .at(-1)
          expect(latest).toMatchObject({ partID: f.part.id, removed: true })
          expect((await Storage.readMany([partKey]))[0]).toBeUndefined()
        } finally {
          await reopened.close()
        }
      } finally {
        stopRemoval()
        release.resolve()
        await exporter.close()
      }
    })
  },
)

test("an acknowledgement cannot erase a newer part update received during its flight", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const f = await fixture()
    const sent = Promise.withResolvers<void>()
    const acknowledge = Promise.withResolvers<void>()
    let first = true
    const remote = transport(f.session.id, async () => {
      if (!first) return
      first = false
      sent.resolve()
      await acknowledge.promise
    })
    const exporter = startMemberSyncExporter({
      identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
      connection: remote.connection,
      signal: new AbortController().signal,
    })
    try {
      const flushing = exporter.flush()
      await sent.promise
      const latest = { ...f.part, text: "Update after transmission before acknowledgement" }
      await ScopeContext.provide({ scope: f.scope, workspace: null, fn: () => Session.updatePart(latest) })
      const draftID = createHash("sha256")
        .update(JSON.stringify({ type: "part", sessionID: f.session.id, partID: f.part.id }))
        .digest("hex")
        .slice(0, 32)
      const deadline = Date.now() + 2000
      for (;;) {
        const draft = await Storage.read<{ event: Sync.Event }>(Keys.draft(binding.orgID, f.session.id, draftID))
        if (JSON.stringify(draft).includes(latest.text)) break
        if (Date.now() > deadline) throw new Error("Latest part was not durably queued")
        await Bun.sleep(5)
      }
      acknowledge.resolve()
      await flushing
      await exporter.flush()
      const last = remote.batches
        .flatMap((batch) => batch.events)
        .filter((event) => event.type === "part")
        .at(-1)
      expect(last).toMatchObject({ partID: f.part.id, part: { content: { text: latest.text } } })
      expect(remote.batches.length).toBeGreaterThan(1)
    } finally {
      acknowledge.resolve()
      await exporter.close()
    }
  })
})

test("history beyond one batch publishes its root first and drains every part", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const f = await fixture()
    await ScopeContext.provide({
      scope: f.scope,
      workspace: null,
      fn: async () => {
        for (let i = 0; i < 270; i++)
          await Session.updatePart({ ...f.part, id: Identifier.ascending("part"), text: `History part ${i}` })
      },
    })
    const remote = transport(f.session.id)
    const exporter = startMemberSyncExporter({
      identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
      connection: remote.connection,
      signal: new AbortController().signal,
    })
    try {
      await exporter.flush()
      await exporter.flush()
      const parts = remote.batches.flatMap((batch) => batch.events).filter((event) => event.type === "part")
      expect(new Set(parts.map((part) => part.partID)).size).toBe(271)
      expect(remote.batches.every((batch) => Buffer.byteLength(JSON.stringify(batch)) <= 1024 * 1024)).toBe(true)
    } finally {
      await exporter.close()
    }
  })
})

test("startup migration indexes legacy pending drafts and survives repeated opening", async () => {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "sync-upgrade-"))
  try {
    await using before = await testRuntime({ home })
    await before.run(async () => {
      await Storage.write(Keys.state(binding.orgID, "legacy"), {
        schemaVersion: 1,
        orgID: binding.orgID,
        sessionID: "legacy",
        nextDraft: 4,
        syncState: "pending",
        updatedAt: 1,
      })
      await Storage.write(Keys.draft(binding.orgID, "legacy", "draft"), { draftID: "draft", localSequence: 3 })
    })
    await before.close()
    for (let i = 0; i < 2; i++) {
      await using after = await testRuntime({ home, register: () => registerSessionSchema(binding) })
      await after.run(async () => {
        expect(await Storage.read(Keys.registeredRoot(binding.orgID, "legacy"))).toEqual({ sessionID: "legacy" })
        expect(await Storage.read(Keys.orderedDraft(binding.orgID, "legacy", 3))).toEqual({ draftID: "draft" })
      })
      await after.close()
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("same-generation native metadata, message and Part changes remain durable while the exporter is offline", async () => {
  await using home = await tmpdir()
  let original: Awaited<ReturnType<typeof fixture>>
  let remote: ReturnType<typeof transport>
  {
    await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
    await runtime.run(async () => {
      original = await fixture()
      remote = transport(original.session.id)
      const exporter = startMemberSyncExporter({
        identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
        connection: remote.connection,
        signal: new AbortController().signal,
      })
      await exporter.flush()
      await exporter.close()
      expect(await Storage.read(Keys.state(binding.orgID, original.session.id))).toMatchObject({
        shareGeneration: 1,
        projectionVersion: 2,
      })
      await ScopeContext.provide({
        scope: original.scope,
        workspace: null,
        fn: async () => {
          await Session.update(original.session.id, (value) => {
            value.title = "Offline original title"
          })
          await Session.updateMessage({ ...original.info, summary: { title: "Offline original message", diffs: [] } })
          await Session.updatePart({ ...original.part, text: "Offline original body" })
        },
      })
      expect((await Storage.query({ kind: "event_delivery" })).length).toBeGreaterThan(0)
    })
  }
  await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const previous = remote!.batches.length
    const exporter = startMemberSyncExporter({
      identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
      connection: remote!.connection,
      signal: new AbortController().signal,
    })
    try {
      await exporter.flush()
      const events = remote!.batches.slice(previous).flatMap((batch) => batch.events)
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session",
          session: expect.objectContaining({ sessionID: original!.session.id, title: "Offline original title" }),
        }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({ type: "message", messageID: original!.info.id, summary: "Offline original message" }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "part",
          partID: original!.part.id,
          part: expect.objectContaining({ type: "text", content: { kind: "inline", text: "Offline original body" } }),
        }),
      )
      expect(await Storage.query({ kind: "event_delivery" })).toEqual([])
    } finally {
      await exporter.close()
    }
  })
})

test("ordinary shared export advances its healthy root while another root is frozen and retains that root's original delivery", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const blocked = await fixture()
    const healthy = await fixture()
    const source = {
      sessionID: blocked.session.id,
      scopeID: binding.projectID,
      handoffID: "original-blocked-source",
      sourceID: binding.driverRuntimeID,
      targetID: "other-runtime",
      fromEpoch: 1,
      toEpoch: 2,
    }
    await ScopeContext.provide({
      scope: blocked.scope,
      workspace: null,
      fn: async () => {
        await SessionLifecycle.pause({ sessionID: blocked.session.id, reason: "interrupted" })
        await Epochs.beginSource(source)
      },
    })
    const retained = async () =>
      (await Storage.query<{ payload: unknown }>({ kind: "event_delivery" })).filter(
        (row) => z.object({ rootSessionID: z.literal(blocked.session.id) }).safeParse(row.value.payload).success,
      )
    const before = await retained()
    expect(before.length).toBeGreaterThan(0)
    const remote = transport(healthy.session.id)
    const exporter = startMemberSyncExporter({
      identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
      connection: remote.connection,
      signal: new AbortController().signal,
    })
    try {
      await exporter.flush()
      expect(remote.batches.flatMap((batch) => batch.events)).toContainEqual(
        expect.objectContaining({ type: "part", partID: healthy.part.id }),
      )
      expect(await retained()).toEqual(before)
      await expect(drainMemberSync(blocked.session.id, { ...source, handoffID: "foreign-source" })).rejects.toThrow()
      expect(await retained()).toEqual(before)
      const actual = await Epochs.ownerPreparationBinding({ sessionID: source.sessionID, handoffID: source.handoffID })
      const original = await nativeSyncBinding(blocked.session.id, binding.orgID)
      if (!original) throw new Error("Original shared source is unavailable")
      const release = Promise.withResolvers<void>()
      let escaped: Promise<void> | undefined
      await prepareNativeSync(actual, async () => {
        escaped = release.promise.then(() => pumpNativeSync(original))
      })
      release.resolve()
      await expect(escaped!).rejects.toThrow("exact source preparation frame")
      expect(await retained()).toEqual(before)
      await drainMemberSync(
        blocked.session.id,
        await Epochs.ownerPreparationBinding({ sessionID: source.sessionID, handoffID: source.handoffID }),
      )
      expect(await retained()).toEqual([])
      expect(remote.batches.every((batch) => batch.sessionID === healthy.session.id)).toBe(true)
    } finally {
      await exporter.close()
    }
  })
})

test("native removal, evidence pruning and artifact collection preserve original shared dependencies until their actual ACK", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const f = await fixture()
    const owner = { kind: "session", scopeID: f.scope.id, sessionID: f.session.id } as const
    const bytes = "Original unacknowledged binary dependency".repeat(4096)
    const artifact = await RolloutArtifact.writeText(owner, bytes, "text/plain")
    const attachment = MessageV2.AttachmentPart.parse({
      id: Identifier.ascending("part"),
      sessionID: f.session.id,
      messageID: f.info.id,
      type: "attachment",
      mime: "text/plain",
      filename: "original.txt",
      url: "attachment://original",
      artifact,
    })
    await ScopeContext.provide({ scope: f.scope, workspace: null, fn: () => Session.updatePart(attachment) })
    const prune = () =>
      Storage.transaction((tx) =>
        tx.pruneTreeWithinBudget(RolloutArtifact.root(owner), {
          limits: { records: 2048, nodes: 4096, artifacts: 256 },
          cutoff: Date.now() + 30 * 86400_000,
          active: () => false,
          maintenance: true,
        }),
      )
    await expect(prune()).rejects.toThrow("original outbox acknowledgement")
    const original = async () => {
      const chunks = await Array.fromAsync(RolloutArtifact.read(owner, artifact))
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString()
    }
    await Storage.collectArtifactGarbage({ scanOrphans: true })
    expect(await original()).toBe(bytes)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const remote = transport(f.session.id, async () => {
      entered.resolve()
      await release.promise
    })
    remote.connection.uploadBlob = async (input) => ({
      sessionID: f.session.id,
      shareGeneration: input.shareGeneration,
      hash: input.hash,
      bytes: input.totalBytes,
      chunkBytes: 4 * 1024 * 1024,
      receivedBytes: input.offset + input.bytes.byteLength,
      complete: input.offset + input.bytes.byteLength === input.totalBytes,
    })
    const exporter = startMemberSyncExporter({
      identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
      connection: remote.connection,
      signal: new AbortController().signal,
    })
    let flushing: Promise<void> | undefined
    try {
      flushing = exporter.flush()
      await entered.promise
      expect(await Storage.query({ kind: "event_delivery" })).toEqual([])
      expect((await Storage.query({ prefix: Keys.drafts(binding.orgID, f.session.id) })).length).toBeGreaterThan(0)
      await expect(prune()).rejects.toThrow("original outbox acknowledgement")
      await expect(
        ScopeContext.provide({ scope: f.scope, workspace: null, fn: () => Session.remove(f.session.id) }),
      ).rejects.toThrow("original outbox acknowledgement")
      await Storage.collectArtifactGarbage({ scanOrphans: true })
      expect(await original()).toBe(bytes)
      release.resolve()
      await flushing
      await exporter.close()
      expect(await Storage.query({ prefix: Keys.drafts(binding.orgID, f.session.id) })).toEqual([])
      const pruned = await prune()
      expect(pruned.records).toBeGreaterThan(0)
      await Storage.collectArtifactGarbage({ scanOrphans: true })
      await expect(original()).rejects.toThrow()
    } finally {
      release.resolve()
      await flushing
      await exporter.close()
    }
  })
})

test("pending native changes allow original streamed replacement and Part removal before their durable pump", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const f = await fixture()
    await ScopeContext.provide({
      scope: f.scope,
      workspace: null,
      fn: async () => {
        await Session.updatePart({ ...f.part, text: "Offline queued update" })
        expect((await Storage.query({ kind: "event_delivery" })).length).toBeGreaterThan(0)
        await Session.removePart({ sessionID: f.session.id, messageID: f.info.id, partID: f.part.id })
        expect(
          await MessageV2.readPart({
            scopeID: f.scope.id,
            sessionID: f.session.id,
            messageID: f.info.id,
            partID: f.part.id,
          }),
        ).toBeUndefined()
        const streaming = MessageV2.TextPart.parse({ ...f.part, id: Identifier.ascending("part"), text: "" })
        const delta = "Original streaming content ".repeat(300)
        streaming.text += delta
        await Session.updatePartDelta(streaming, delta)
        await Session.flushPartWrites(f.session.id)
        const key = ["sessions", f.scope.id, f.session.id, "messages", f.info.id, "parts", streaming.id]
        expect(await Storage.read(key)).toHaveProperty("textContent")
        await Session.updatePart({ ...streaming, text: "Original explicit replacement" })
        expect(
          await MessageV2.readPart({
            scopeID: f.scope.id,
            sessionID: f.session.id,
            messageID: f.info.id,
            partID: streaming.id,
          }),
        ).toMatchObject({ text: "Original explicit replacement" })
        expect(await Storage.read(key)).not.toHaveProperty("textContent")
        const remote = transport(f.session.id)
        const exporter = startMemberSyncExporter({
          identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
          connection: remote.connection,
          signal: new AbortController().signal,
        })
        try {
          await exporter.flush()
          const events = remote.batches.flatMap((batch) => batch.events)
          expect(events).toContainEqual(expect.objectContaining({ type: "part", partID: f.part.id, removed: true }))
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "part",
              partID: streaming.id,
              part: expect.objectContaining({
                type: "text",
                content: { kind: "inline", text: "Original explicit replacement" },
              }),
            }),
          )
          expect(await Storage.query({ kind: "event_delivery" })).toEqual([])
        } finally {
          await exporter.close()
        }
      },
    })
  })
})

test("a committed attachment batch with lost ACK keeps its original content after the native part changes artifact", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const f = await fixture()
    const owner = { kind: "session", scopeID: f.scope.id, sessionID: f.session.id } as const
    const first = await RolloutArtifact.writeText(owner, "Original attachment X", "text/plain")
    const second = await RolloutArtifact.writeText(owner, "Original attachment Y", "text/plain")
    const part = MessageV2.AttachmentPart.parse({
      id: Identifier.ascending("part"),
      sessionID: f.session.id,
      messageID: f.info.id,
      type: "attachment",
      mime: "text/plain",
      filename: "original.txt",
      url: "attachment://original",
      artifact: first,
    })
    await ScopeContext.provide({ scope: f.scope, workspace: null, fn: () => Session.updatePart(part) })
    const remote = transport(f.session.id)
    const uploaded: Array<{ hash: string; bytes: Uint8Array }> = []
    remote.connection.uploadBlob = async (input) => {
      uploaded.push({ hash: input.hash, bytes: input.bytes.slice() })
      return Sync.BlobStatus.parse({
        sessionID: input.sessionID,
        shareGeneration: input.shareGeneration,
        hash: input.hash,
        bytes: input.totalBytes,
        chunkBytes: 4 * 1024 * 1024,
        receivedBytes: input.offset + input.bytes.length,
        complete: input.offset + input.bytes.length === input.totalBytes,
      })
    }
    const send = remote.connection.sync
    const receipts = new Map<string, Sync.Ack>()
    let holdAcknowledgement = true
    remote.connection.sync = async (batch, signal) => {
      let receipt = receipts.get(batch.payloadHash)
      if (!receipt) {
        receipt = await send(batch, signal)
        receipts.set(batch.payloadHash, receipt)
      }
      if (holdAcknowledgement) throw new Error("The original committed batch acknowledgement was lost")
      return receipt
    }
    const exporter = startMemberSyncExporter({
      identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
      connection: remote.connection,
      signal: new AbortController().signal,
    })
    let retry: ReturnType<typeof startMemberSyncExporter> | undefined
    try {
      await exporter.flush()
      expect(receipts.size).toBe(1)
      const originalBatch = StoredBatch.parse(await Storage.read(Keys.batch(binding.orgID, f.session.id)))
      await exporter.close()
      expect(originalBatch).toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({ type: "attachment", attachmentID: part.id, hash: first.sha256 }),
        ]),
      })
      await ScopeContext.provide({
        scope: f.scope,
        workspace: null,
        fn: () => Session.updatePart({ ...part, artifact: second }),
      })
      const bound = await nativeSyncBinding(f.session.id, binding.orgID)
      if (!bound) throw new Error("Original native shared binding is unavailable")
      await pumpNativeSync(bound)
      expect(await Storage.read(Keys.batch(binding.orgID, f.session.id))).toEqual(originalBatch)
      await Storage.collectArtifactGarbage({ scanOrphans: true })
      holdAcknowledgement = false
      retry = startMemberSyncExporter({
        identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
        connection: remote.connection,
        signal: new AbortController().signal,
      })
      const beforeRetry = uploaded.length
      await retry.flush()
      const [remaining] = await Storage.readMany([Keys.batch(binding.orgID, f.session.id)])
      expect(remaining === undefined ? undefined : StoredBatch.parse(remaining).payloadHash).not.toBe(
        originalBatch.payloadHash,
      )
      expect(
        uploaded
          .slice(beforeRetry)
          .filter((entry) => entry.hash === first.sha256)
          .map((entry) => Buffer.from(entry.bytes).toString()),
      ).toEqual(["Original attachment X"])
      await retry.flush()
      expect(
        uploaded.filter((entry) => entry.hash === second.sha256).map((entry) => Buffer.from(entry.bytes).toString()),
      ).toEqual(["Original attachment Y"])
    } finally {
      holdAcknowledgement = false
      await retry?.close()
      await exporter.close()
    }
  })
})

test("a detached exporter close remains idempotent after its original Runtime is disposed", async () => {
  const runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  const remote = transport("closed-original-runtime")
  const exporter = await runtime.run(() =>
    startMemberSyncExporter({
      identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" },
      connection: remote.connection,
      signal: new AbortController().signal,
    }),
  )
  try {
    const closed = RuntimeContext.exit(() => exporter.close())
    await closed
    await runtime.close()
    await expect(exporter.close()).resolves.toBeUndefined()
    expect(remote.batches).toEqual([])
  } finally {
    await runtime.close()
  }
})
