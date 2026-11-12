import { expect, test } from "bun:test"
import {
  OrganizationSessionProtocol as Sessions,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { startMemberSyncExporter, drainMemberSync } from "../src/sync-exporter"
import type { MemberConnection } from "../src/connection"
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
  const connection: Pick<MemberConnection, "connected" | "sync" | "syncState" | "uploadBlob"> = {
    connected: {
      type: "handshake",
      protocolVersion: 1,
      orgID: binding.orgID,
      deploymentIncarnation: "deployment-sync",
      runtimeID: binding.driverRuntimeID,
      connectionEpoch: 1,
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
        syncState: "pending",
        updatedAt: 1,
      }
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
  return { connection, batches }
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
