import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { BlobRecord } from "../src/sync-projection"
import { OrganizationSessionAdoption as Adoption } from "../src/session-adoption"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import {
  SessionTransferCore as Core,
  SessionTransferSource as Source,
  SessionTransferStream as Stream,
  SessionTransferEpochs as Epochs,
  SessionTransferOwners as Owners,
  SessionTransferStaging as Staging,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { registerSessionSchema } from "../src/session-schema"
import { registerOrganizationTransferOwner } from "../src/session-transfer"
import { OrganizationSyncPath as Keys } from "../src/storage/path"
import { binding as nativeBinding } from "../src/sync-outbox"
import { pumpNativeSync } from "../src/sync-native-source"
import { startMemberSyncExporter } from "../src/sync-exporter"
import { Batch as StoredBatch } from "../src/sync-outbox"
import type { MemberConnection } from "../src/connection"

const binding = {
  schemaVersion: 1,
  orgID: "portable-sync-org",
  projectID: "portable-sync-project",
  creatorID: "creator",
  driverRuntimeID: "portable-source",
  bindingEpoch: 1,
} as const
function objects() {
  const values = new Map<string, Uint8Array>()
  return {
    async put(hash: string, value: Uint8Array) {
      values.set(hash, value.slice())
    },
    async get(hash: string, maximum: number) {
      const value = values.get(hash)
      if (!value || value.byteLength > maximum) throw new Error("Missing original bounded transfer object")
      return value.slice()
    },
  }
}
async function fixture(large = true) {
  const scope = await Scope.registerProject({
    type: "project",
    id: binding.projectID,
    local: null,
    time: { created: 1, updated: 1 },
  })
  return ScopeContext.provide({
    scope,
    workspace: null,
    fn: async () => {
      const session = await Session.create({
        organization: binding,
        workspaceID: null,
        environmentID: null,
      })
      const message = MessageV2.User.parse({
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "user",
        time: { created: 1 },
        agent: PrimaryAgentIdentity.names.general,
        model: { providerID: "fixture", modelID: "fixture" },
      })
      await Session.updateMessage(message)
      await Session.updatePart(
        MessageV2.TextPart.parse({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: large ? "Original bounded native text ".repeat(2600) : "Original native checksum text",
        }),
      )
      const native = await nativeBinding(session.id, binding.orgID, scope.id)
      if (!native) throw new Error("Original native organization binding is missing")
      await pumpNativeSync(native)
      await SessionLifecycle.pause({
        sessionID: session.id,
        reason: "interrupted",
      })
      const epoch = {
        sessionID: session.id,
        scopeID: scope.id,
        handoffID: "portable-sync-transfer",
        sourceID: binding.driverRuntimeID,
        targetID: "portable-target",
        fromEpoch: 1,
        toEpoch: 2,
      }
      return { scope, session, epoch }
    },
  })
}
function register() {
  Core.register()
  registerSessionSchema(binding)
  registerOrganizationTransferOwner()
}

test("the original native source manifest retains the shared outbox and original content dependencies outside Session core", async () => {
  await using runtime = await testRuntime({ register })
  await runtime.run(async () => {
    const f = await fixture()
    const store = objects()
    const original = await Storage.query({
      prefix: Keys.drafts(binding.orgID, f.session.id),
      limit: 256,
    })
    expect(original.length).toBeGreaterThan(0)
    expect(
      (
        await Storage.query({
          prefix: Keys.blobs(binding.orgID, f.session.id),
          limit: 1,
        })
      ).length,
    ).toBe(1)
    const prepared = await Source.prepare({
      binding: f.epoch,
      store,
      signal: new AbortController().signal,
      async verify() {},
    })
    const rows: { key: string[]; value: unknown; owner: unknown }[] = []
    await using reader = await Stream.open({ root: prepared.root, store, directory: Global.Path.cache })
    for await (const entry of reader.entries()) {
      const chunks: Uint8Array[] = []
      for await (const bytes of entry.content) chunks.push(bytes)
      if (entry.kind !== "record") continue
      const key = entry.metadata.key
      if (Array.isArray(key) && key.every((segment): segment is string => typeof segment === "string"))
        rows.push({
          key,
          value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          owner: entry.metadata.transferOwner,
        })
    }
    expect(rows.some((row) => row.owner === "session-core" && row.key[3] === "rollout")).toBe(true)
    expect((await Source.status(f.epoch))?.manifestHash).toBe(prepared.manifestHash)
    const sync = rows.filter((row) => row.owner === "organization-sync")
    expect(
      sync.some((row) => JSON.stringify(row.key) === JSON.stringify(Keys.state(binding.orgID, f.session.id))),
    ).toBe(true)
    const drafts = sync.filter((row) => row.key[4] === "drafts")
    expect(drafts.length).toBeGreaterThan(0)
    for (const row of original)
      expect(drafts.find((entry) => JSON.stringify(entry.key) === JSON.stringify(row.key))).toBeDefined()
    expect(sync.some((row) => row.key[4] === "blobs")).toBe(true)
  })
}, 20000)

test("cold source checkpoints read only the same sealed manifest and reject another native receipt", async () => {
  const { OrganizationSyncTransfer: SyncTransfer } = await import("../src/sync-transfer")
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-sync-portable-"))
  const store = objects()
  try {
    const first = await testRuntime({ home: directory, register })
    let saved: Awaited<ReturnType<typeof fixture>> | undefined
    let prepared: Awaited<ReturnType<typeof Source.prepare>> | undefined
    try {
      await first.run(async () => {
        saved = await fixture()
        prepared = await Source.prepare({
          binding: saved.epoch,
          store,
          signal: new AbortController().signal,
          async verify() {},
        })
      })
    } finally {
      await first.close()
    }
    if (!saved || !prepared) throw new Error("The original native source did not seal")
    const original = saved
    const sealed = prepared
    await using second = await testRuntime({ home: directory, register })
    await second.run(async () => {
      let reads = 0
      const reader = {
        async record(input: { manifestHash: string; ownerID: string; key: readonly string[] }) {
          reads++
          if (input.manifestHash !== sealed.manifestHash) throw new Error("Wrong immutable native source")
          await using native = await Stream.open({ root: sealed.root, store, directory: Global.Path.cache })
          for await (const entry of native.entries()) {
            const matches =
              entry.kind === "record" &&
              entry.metadata.transferOwner === input.ownerID &&
              entry.metadata.transferSessionID === original.session.id &&
              JSON.stringify(entry.metadata.key) === JSON.stringify(input.key)
            const blocks: Uint8Array[] = []
            for await (const bytes of entry.content) blocks.push(bytes)
            if (matches) return JSON.parse(Buffer.concat(blocks).toString("utf8"))
          }
          throw new Error("The sealed source has no original owning header")
        },
      }
      const checkpoint = await SyncTransfer.sourceCheckpoint(
        original.epoch,
        sealed.manifestHash,
        new AbortController().signal,
        reader,
      )
      expect(checkpoint.pendingBatch).toBeNull()
      expect(reads).toBe(1)
      await expect(
        SyncTransfer.sourceCheckpoint(original.epoch, "f".repeat(64), new AbortController().signal, reader),
      ).rejects.toThrow("actual sealed native source")
      expect(reads).toBe(1)
      await expect(
        SyncTransfer.sourceCheckpoint(
          { ...original.epoch, handoffID: "foreign-source" },
          sealed.manifestHash,
          new AbortController().signal,
          reader,
        ),
      ).rejects.toThrow()
      expect(reads).toBe(1)
      expect(
        await SyncTransfer.sourceCheckpoint(original.epoch, sealed.manifestHash, new AbortController().signal, reader),
      ).toEqual(checkpoint)
      expect((await Source.status(original.epoch))?.manifestHash).toBe(sealed.manifestHash)
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 20000)

test("the original destination activation publishes the portable sync prefix and keeps original native blob bytes", async () => {
  const store = objects()
  await using source = await testRuntime({ register })
  const frozen = await source.run(async () => {
    const f = await fixture()
    const prepared = await Source.prepare({
      binding: f.epoch,
      store,
      signal: new AbortController().signal,
      async verify() {},
    })
    return {
      ...f,
      session: await Session.get(f.session.id),
      prepared,
      projections: (await Storage.query({ prefix: Keys.projections(binding.orgID, f.session.id), limit: 256 })).map(
        (row) => ({ key: row.key, value: row.value }),
      ),
    }
  })
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const signingIdentity = {
    schemaVersion: 1,
    orgID: binding.orgID,
    deploymentIncarnation: "portable-deployment",
    keyID: "portable-key",
    publicKey: await Runtime.publicKey(keys.publicKey),
  } as const
  await using target = await testRuntime({ register })
  await target.run(async () => {
    await Staging.receive({ handoffID: frozen.epoch.handoffID, root: frozen.prepared.root, store })
    await Epochs.reserve(frozen.epoch, frozen.prepared.manifestHash)
    const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
    for (const ownerID of Owners.publicationOrder(Object.keys(frozen.prepared.root.owners))) {
      const context = await Staging.context({
        handoffID: frozen.epoch.handoffID,
        ownerID,
        session: frozen.session,
        rootSessionID: frozen.session.id,
        mapping: {},
        signal: new AbortController().signal,
      })
      await Owners.validate(ownerID, context)
      contexts.push({ ownerID, context })
    }
    const permit = Handoff.Permit.parse({
      schemaVersion: 1,
      orgID: binding.orgID,
      deploymentIncarnation: signingIdentity.deploymentIncarnation,
      handoffID: frozen.epoch.handoffID,
      sessionID: frozen.session.id,
      sourceRuntimeID: frozen.epoch.sourceID,
      targetRuntimeID: frozen.epoch.targetID,
      fromEpoch: 1,
      toEpoch: 2,
      mappingPlanRevision: 1,
      shareGeneration: 0,
      purpose: "handoff-activation",
      permitID: "portable-activate",
      keyID: signingIdentity.keyID,
      manifestHash: frozen.prepared.manifestHash,
      preparedHash: "a".repeat(64),
      sourceBinding: binding,
      createdAt: Date.now(),
    })
    const connection = Runtime.Connected.parse({
      type: "handshake",
      protocolVersion: 1,
      orgID: binding.orgID,
      deploymentIncarnation: signingIdentity.deploymentIncarnation,
      runtimeID: frozen.epoch.targetID,
      connectionEpoch: 1,
      signingIdentity,
      heartbeatMs: 1000,
      offlineMs: 10000,
    })
    await Adoption.run({ permit, signature: await Handoff.signPermit(permit, keys.privateKey) }, connection, () =>
      Epochs.activateMany({
        bindings: [frozen.epoch],
        manifestHash: permit.manifestHash,
        publish: () => Staging.publish({ handoffID: permit.handoffID, contexts }),
      }),
    )
    expect((await Session.get(frozen.session.id)).organization).toEqual({
      ...binding,
      driverRuntimeID: frozen.epoch.targetID,
      bindingEpoch: 2,
    })
    expect((await Session.get(frozen.session.id)).paused).toBeDefined()
    for (const original of frozen.projections) expect(await Storage.read(original.key)).toEqual(original.value)
    const blobs = await Storage.query({ prefix: Keys.blobs(binding.orgID, frozen.session.id), limit: 128 })
    expect(blobs).toHaveLength(1)
    const retained = BlobRecord.parse(blobs[0]!.value)
    let bytes = 0
    for await (const block of RolloutArtifact.read(retained.owner, retained.artifact)) bytes += block.byteLength
    expect(bytes).toBe(retained.artifact.bytes)
    expect(bytes).toBeGreaterThan(64 * 1024)
    expect((await Storage.query({ kind: "event_delivery" })).length).toBeGreaterThan(0)
    const current = await nativeBinding(frozen.session.id, binding.orgID)
    if (!current) throw new Error("Activated native sync owner is missing")
    await pumpNativeSync(current)
    expect(await Storage.query({ kind: "event_delivery" })).toEqual([])
    const draftRows = await Storage.query({ prefix: Keys.drafts(binding.orgID, frozen.session.id), limit: 256 })
    expect(draftRows.length).toBeGreaterThan(0)
    expect((await Session.get(frozen.session.id)).paused).toBeDefined()
  })
}, 20000)

test("native source freezing rejects changed draft hashes and event identity in the original writer's immutable batch", async () => {
  for (const corruption of ["hash", "identity"] as const) {
    await using runtime = await testRuntime({ register })
    await runtime.run(async () => {
      const f = await fixture(false)
      const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
      let attempted = 0
      const connection: Pick<MemberConnection, "connected" | "syncState" | "sync" | "uploadBlob"> = {
        connected: {
          type: "handshake",
          protocolVersion: 1,
          orgID: binding.orgID,
          deploymentIncarnation: "checksum-deployment",
          runtimeID: binding.driverRuntimeID,
          connectionEpoch: 1,
          syncVersion: Sync.observationVersion,
          signingIdentity: {
            schemaVersion: 1,
            orgID: binding.orgID,
            deploymentIncarnation: "checksum-deployment",
            keyID: "checksum-key",
            publicKey: await Runtime.publicKey(keys.publicKey),
          },
          heartbeatMs: 1000,
          offlineMs: 10000,
        },
        async syncState() {
          return {
            sessionID: f.session.id,
            shareState: "shared",
            shareGeneration: 1,
            bindingEpoch: 1,
            nextSeq: 1,
            syncState: "pending",
            updatedAt: 1,
          }
        },
        async sync() {
          attempted++
          throw new Error("Original transport has no remote receipt")
        },
        async uploadBlob() {
          throw new Error("This native codec fixture has no blob transport")
        },
      }
      const exporter = startMemberSyncExporter({
        identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "checksum-device" },
        connection,
        signal: new AbortController().signal,
      })
      try {
        await exporter.flush()
      } finally {
        await exporter.close()
      }
      expect(attempted).toBeGreaterThan(0)
      const key = Keys.batch(binding.orgID, f.session.id)
      const original = StoredBatch.parse(await Storage.read(key))
      expect(original.events.length).toBeGreaterThan(0)
      expect(original.draftHashes?.length).toBe(original.events.length)
      const modified = structuredClone(original)
      if (corruption === "hash")
        modified.draftHashes![0] = (modified.draftHashes![0]!.startsWith("f") ? "e" : "f").repeat(64)
      else modified.draftIDs[0] = "0".repeat(32)
      await Storage.write(key, modified)
      expect(modified.payloadHash).toBe(original.payloadHash)
      expect(modified.events).toEqual(original.events)
      await expect(
        Source.prepare({ binding: f.epoch, store: objects(), signal: new AbortController().signal, async verify() {} }),
      ).rejects.toThrow("original draft content or identity")
      expect(await Storage.read(key)).toEqual(modified)
      expect(await Source.status(f.epoch)).toBeUndefined()
      expect(await Epochs.isFrozen(f.session.id)).toBe(true)
    })
  }
}, 20000)

test("finite source settlement rejects changed live draft identities before upload or sync after its native manifest is sealed", async () => {
  const { OrganizationSyncTransfer: SyncTransfer } = await import("../src/sync-transfer")
  for (const corruption of ["hash", "identity"] as const) {
    await using runtime = await testRuntime({ register })
    await runtime.run(async () => {
      const f = await fixture(false)
      const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
      const calls = { sync: 0, upload: 0, receipt: 0 }
      const connection: Pick<MemberConnection, "connected" | "syncState" | "sync" | "uploadBlob" | "syncBatchReceipt"> =
        {
          connected: {
            type: "handshake",
            protocolVersion: 1,
            orgID: binding.orgID,
            deploymentIncarnation: "finite-deployment",
            runtimeID: binding.driverRuntimeID,
            connectionEpoch: 1,
            syncVersion: Sync.observationVersion,
            signingIdentity: {
              schemaVersion: 1,
              orgID: binding.orgID,
              deploymentIncarnation: "finite-deployment",
              keyID: "finite-key",
              publicKey: await Runtime.publicKey(keys.publicKey),
            },
            heartbeatMs: 1000,
            offlineMs: 10000,
          },
          async syncState() {
            return {
              sessionID: f.session.id,
              shareState: "shared",
              shareGeneration: 1,
              bindingEpoch: 1,
              nextSeq: 1,
              syncState: "pending",
              updatedAt: 1,
            }
          },
          async sync() {
            calls.sync++
            throw new Error("Original transport has no remote receipt")
          },
          async uploadBlob() {
            calls.upload++
            throw new Error("This native fixture has no blob transport")
          },
          async syncBatchReceipt({ batch }) {
            calls.receipt++
            return { state: "absent", batch }
          },
        }
      const exporter = startMemberSyncExporter({
        identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "finite-device" },
        connection,
        signal: new AbortController().signal,
      })
      try {
        await exporter.flush()
        expect(calls.sync).toBeGreaterThan(0)
        const key = Keys.batch(binding.orgID, f.session.id)
        const original = StoredBatch.parse(await Storage.read(key))
        const store = objects()
        const sealed = await Source.prepare({
          binding: f.epoch,
          store,
          signal: new AbortController().signal,
          async verify() {},
        })
        expect((await Source.status(f.epoch))?.manifestHash).toBe(sealed.manifestHash)
        const reader = {
          async record(input: { manifestHash: string; ownerID: string; key: readonly string[] }) {
            if (input.manifestHash !== sealed.manifestHash) throw new Error("Wrong sealed native source")
            await using native = await Stream.open({ root: sealed.root, store, directory: Global.Path.cache })
            for await (const entry of native.entries()) {
              const blocks: Uint8Array[] = []
              for await (const bytes of entry.content) blocks.push(bytes)
              if (
                entry.kind === "record" &&
                entry.metadata.transferOwner === input.ownerID &&
                entry.metadata.transferSessionID === f.session.id &&
                JSON.stringify(entry.metadata.key) === JSON.stringify(input.key)
              )
                return JSON.parse(Buffer.concat(blocks).toString("utf8"))
            }
            throw new Error("Original sealed source header is missing")
          },
        }
        const checkpoint = await SyncTransfer.sourceCheckpoint(
          f.epoch,
          sealed.manifestHash,
          new AbortController().signal,
          reader,
        )
        expect(checkpoint.pendingBatch).toMatchObject({ sessionID: f.session.id, payloadHash: original.payloadHash })
        const modified = structuredClone(original)
        if (corruption === "hash")
          modified.draftHashes![0] = (modified.draftHashes![0]!.startsWith("f") ? "e" : "f").repeat(64)
        else modified.draftIDs[0] = "0".repeat(32)
        await Storage.write(key, modified)
        expect(modified.events).toEqual(original.events)
        const before = { ...calls }
        let failure: unknown
        try {
          await SyncTransfer.settleSource(f.epoch, sealed.manifestHash, new AbortController().signal, reader)
        } catch (error) {
          failure = error
        }
        expect(calls.receipt).toBeGreaterThan(before.receipt)
        expect(calls.upload).toBe(before.upload)
        expect(calls.sync).toBe(before.sync)
        expect(failure).toBeInstanceOf(Error)
        if (!(failure instanceof Error)) throw new Error("Corrupt live batch did not retain its original error")
        expect(failure.message).toContain("original draft content or identity")
        expect(await Storage.read(key)).toEqual(modified)
        expect(
          await SyncTransfer.sourceCheckpoint(f.epoch, sealed.manifestHash, new AbortController().signal, reader),
        ).toEqual(checkpoint)
        expect((await Source.status(f.epoch))?.manifestHash).toBe(sealed.manifestHash)
      } finally {
        await exporter.close()
      }
    })
  }
}, 20000)
