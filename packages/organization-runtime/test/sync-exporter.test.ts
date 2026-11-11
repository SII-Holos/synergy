import { expect, test } from "bun:test"
import { OrganizationSessionProtocol as Sessions, OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
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
import { startMemberSyncExporter } from "../src/sync-exporter"
import type { MemberConnection } from "../src/connection"
import { registerSessionSchema } from "../src/session-schema"
import { OrganizationSyncPath as Keys } from "../src/storage/path"

const binding: Sessions.Binding = { schemaVersion: 1, orgID: "org-sync", projectID: "project-sync", creatorID: "creator-sync", driverRuntimeID: "runtime-sync", bindingEpoch: 1 }

async function fixture() {
  const scope = await Scope.registerProject({ type: "project", id: binding.projectID, local: null, time: { created: 1, updated: 1 } })
  const session = await ScopeContext.provide({ scope, workspace: null, fn: () => Session.create({ organization: binding, workspaceID: null }) })
  await Storage.write(Keys.state(binding.orgID, session.id), { schemaVersion: 1, orgID: binding.orgID, sessionID: session.id, nextDraft: 1, syncState: "pending", updatedAt: 1 })
  await Storage.write(Keys.registeredRoot(binding.orgID, session.id), { sessionID: session.id })
  const info = MessageV2.User.parse({ id: Identifier.ascending("message"), sessionID: session.id, role: "user", time: { created: 2 }, agent: "general", model: { providerID: "fixture", modelID: "model" } })
  await ScopeContext.provide({ scope, workspace: null, fn: () => Session.updateMessage(info) })
  const part = MessageV2.TextPart.parse({ id: Identifier.ascending("part"), sessionID: session.id, messageID: info.id, type: "text", text: "Historical shared dialogue" })
  await ScopeContext.provide({ scope, workspace: null, fn: () => Session.updatePart(part) })
  return { session, info, part, scope }
}

function transport(sessionID: string, receive?: (batch: Sync.Batch) => Promise<void>) {
  const batches: Sync.Batch[] = []
  let nextSeq = 1
  const connection: Pick<MemberConnection, "connected" | "sync" | "syncState" | "uploadBlob"> = {
    connected: { type: "handshake", protocolVersion: 1, orgID: binding.orgID, deploymentIncarnation: "deployment-sync", runtimeID: binding.driverRuntimeID, connectionEpoch: 1, signingIdentity: { schemaVersion: 1, orgID: binding.orgID, deploymentIncarnation: "deployment-sync", keyID: "key-sync", publicKey: "a".repeat(64) }, heartbeatMs: 10, offlineMs: 100 },
    async syncState() { return { sessionID, shareState: "shared", shareGeneration: 1, bindingEpoch: 1, nextSeq, syncState: "pending", updatedAt: 1 } },
    async sync(batch) {
      if (nextSeq === 1) expect(batch.events[0]).toMatchObject({ type: "session", session: { sessionID } })
      batches.push(batch)
      await receive?.(batch)
      nextSeq = batch.lastSeq + 1
      return { sessionID, shareGeneration: 1, bindingEpoch: 1, nextSeq, syncState: "synced" }
    },
    async uploadBlob() { throw new Error("This fixture does not publish blobs") },
  }
  return { connection, batches }
}

test("sharing after restart backfills canonical history before streaming live updates", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const f = await fixture()
    const remote = transport(f.session.id)
    const exporter = startMemberSyncExporter({ identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" }, connection: remote.connection, signal: new AbortController().signal })
    try {
      await exporter.flush()
      const events = remote.batches.flatMap((batch) => batch.events)
      expect(events).toContainEqual(expect.objectContaining({ type: "message", messageID: f.info.id, model: f.info.model }))
      expect(events).toContainEqual(expect.objectContaining({ type: "part", partID: f.part.id, part: { type: "text", content: { kind: "inline", text: f.part.text }, origin: "user" } }))
    } finally { exporter.close() }
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
    const exporter = startMemberSyncExporter({ identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" }, connection: remote.connection, signal: new AbortController().signal })
    try {
      const flushing = exporter.flush()
      await sent.promise
      const latest = { ...f.part, text: "Update after transmission before acknowledgement" }
      await ScopeContext.provide({ scope: f.scope, workspace: null, fn: () => Session.updatePart(latest) })
      const draftID = createHash("sha256").update(JSON.stringify({ type: "part", sessionID: f.session.id, partID: f.part.id })).digest("hex").slice(0, 32)
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
      const last = remote.batches.flatMap((batch) => batch.events).filter((event) => event.type === "part").at(-1)
      expect(last).toMatchObject({ partID: f.part.id, part: { content: { text: latest.text } } })
      expect(remote.batches.length).toBeGreaterThan(1)
    } finally { acknowledge.resolve(); exporter.close() }
  })
})

test("history beyond one batch publishes its root first and drains every part", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const f = await fixture()
    await ScopeContext.provide({ scope: f.scope, workspace: null, fn: async () => {
      for (let i = 0; i < 270; i++) await Session.updatePart({ ...f.part, id: Identifier.ascending("part"), text: `History part ${i}` })
    } })
    const remote = transport(f.session.id)
    const exporter = startMemberSyncExporter({ identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-sync" }, connection: remote.connection, signal: new AbortController().signal })
    try {
      await exporter.flush()
      await exporter.flush()
      const parts = remote.batches.flatMap((batch) => batch.events).filter((event) => event.type === "part")
      expect(new Set(parts.map((part) => part.partID)).size).toBe(271)
      expect(remote.batches.every((batch) => Buffer.byteLength(JSON.stringify(batch)) <= 1024 * 1024)).toBe(true)
    } finally { exporter.close() }
  })
})

test("startup migration indexes legacy pending drafts and survives repeated opening", async () => {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "sync-upgrade-"))
  try {
    await using before = await testRuntime({ home })
    await before.run(async () => {
      await Storage.write(Keys.state(binding.orgID, "legacy"), { schemaVersion: 1, orgID: binding.orgID, sessionID: "legacy", nextDraft: 4, syncState: "pending", updatedAt: 1 })
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
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})
