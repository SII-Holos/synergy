import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { prepareHostedHome, runtimeIdentityDigest, NativeHomeReaderContract } from "../src/home"
import { enrollHostedRuntime } from "../src/enrollment"
import { registerOrganizationNamespaceIdentity } from "../src/namespace-identity"
import { fixture as organizationFixture } from "./support/organization"
import {
  OrganizationSessionProtocol as Sessions,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { runMigrations } from "@ericsanchezok/synergy-harness/migration"
import * as Migrations from "../src/sync-migration"
import { registerSessionSchema } from "../src/session-schema"
import { startMemberSyncExporter, type MemberSyncExporter } from "../src/sync-exporter"
import { pumpNativeSync } from "../src/sync-native-source"
import { binding as nativeBinding, Batch } from "../src/sync-outbox"
import { AttachmentRecord } from "../src/sync-projection"
import { OrganizationSyncPath as Keys } from "../src/storage/path"
import type { MemberConnection } from "../src/connection"

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
async function invoke(lease: RuntimeMaintenance.Lease, orgID: string) {
  const repair: unknown = Reflect.get(Migrations, "repairOrganizationSyncAttachmentContent")
  if (typeof repair === "function") return repair({ lease, orgID })
  await RuntimeMaintenance.drain(lease)
  return runMigrations({ targetDomain: "organization-sync", maintenance: true, output: "silent" })
}
function transport(sessionID: string, binding: Sessions.Binding) {
  const lost = new Error("Original batch acknowledgement was lost")
  const received: Sync.Batch[] = []
  const uploaded: Uint8Array[] = []
  let nextSeq = 1
  let lose = true
  const connection: Pick<MemberConnection, "connected" | "sync" | "syncState" | "uploadBlob" | "observeSync"> = {
    connected: {
      type: "handshake",
      protocolVersion: 1,
      orgID: binding.orgID,
      deploymentIncarnation: "repair-deployment",
      runtimeID: binding.driverRuntimeID,
      connectionEpoch: 1,
      syncVersion: Sync.observationVersion,
      signingIdentity: {
        schemaVersion: 1,
        orgID: binding.orgID,
        deploymentIncarnation: "repair-deployment",
        keyID: "repair-key",
        publicKey: "a".repeat(64),
      },
      heartbeatMs: 10,
      offlineMs: 100,
    },
    async syncState(id) {
      return {
        sessionID: id,
        shareState: "shared",
        shareGeneration: 1,
        bindingEpoch: 1,
        nextSeq,
        syncState: "pending",
        updatedAt: 1,
      }
    },
    async observeSync(id, observation) {
      return {
        sessionID: id,
        shareState: "shared",
        shareGeneration: 1,
        bindingEpoch: 1,
        nextSeq,
        syncState: observation.state,
        updatedAt: 1,
      }
    },
    async uploadBlob(input) {
      uploaded.push(input.bytes.slice())
      return Sync.BlobStatus.parse({
        sessionID,
        shareGeneration: input.shareGeneration,
        hash: input.hash,
        bytes: input.totalBytes,
        chunkBytes: 4 * 1024 * 1024,
        receivedBytes: input.offset + input.bytes.byteLength,
        complete: input.offset + input.bytes.byteLength === input.totalBytes,
      })
    },
    async sync(batch) {
      received.push(structuredClone(batch))
      nextSeq = Math.max(nextSeq, batch.lastSeq + 1)
      if (lose) {
        lose = false
        throw lost
      }
      return {
        sessionID,
        shareGeneration: batch.shareGeneration,
        bindingEpoch: batch.bindingEpoch,
        nextSeq,
        syncState: "synced",
      }
    },
  }
  return { connection, received, uploaded, lost }
}
async function fixture() {
  const service = await organizationFixture()
  try {
    const home = await prepareHostedHome({
      baseDirectory: path.join(service.root, "repair-homes"),
      identity: { orgID: service.identity.orgID, hostID: "repair-host" },
      origin: service.origin,
    })
    const ticket = (
      await service.client.orgRuntime.registerHosted(
        { orgHostedRuntimeRegistration: { name: "Original repair Home", publicKey: home.publicKey } },
        { headers: service.headers, throwOnError: true },
      )
    ).data
    const registration = await enrollHostedRuntime({ home: home.home, identity: home.identity, ticket, ca: service.ca })
    const project = (
      await service.client.orgProjects.create(
        { orgProjectCreate: { name: "Original repair project", description: "" } },
        { headers: service.headers, throwOnError: true },
      )
    ).data
    const binding: Sessions.Binding = {
      schemaVersion: 1,
      orgID: registration.orgID,
      projectID: project.projectID,
      creatorID: service.identity.accountID,
      driverRuntimeID: registration.runtimeID,
      bindingEpoch: 1,
    }
    let exporter: MemberSyncExporter | undefined
    let bridgeDrained = false
    const runtime = await testRuntime({
      home: home.home,
      register() {
        HomeOwnership.select({
          owner: "organization-runtime",
          identity: runtimeIdentityDigest(home.identity),
          readerContract: NativeHomeReaderContract,
        })
        registerOrganizationNamespaceIdentity(home.identity)
        registerSessionSchema(binding)
        RuntimeMaintenance.configure({ required: ["original-sync-exporter"] })
        RuntimeMaintenance.register("original-sync-exporter", {
          version: 1,
          async suspend(context) {
            await RuntimeMaintenance.assertDraining(context.lease)
          },
          async drain(context) {
            await RuntimeMaintenance.assertDraining(context.lease)
            await exporter?.close()
            bridgeDrained = true
          },
          async inspect() {
            return bridgeDrained
              ? []
              : [
                  {
                    owner: "original-sync-exporter",
                    code: "original_exporter_active",
                    label: "Drain the original exporter",
                    recoverable: true,
                  },
                ]
          },
          async release(context) {
            await RuntimeMaintenance.assertReleasing(context.lease)
          },
        })
      },
    })
    try {
      return await runtime.run(async () => {
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
        const info = MessageV2.User.parse({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: 2 },
          agent: "fixture",
          model: { providerID: "fixture", modelID: "model" },
        })
        await ScopeContext.provide({ scope, workspace: null, fn: () => Session.updateMessage(info) })
        const owner = { kind: "session" as const, scopeID: scope.id, sessionID: session.id }
        const bodyX = "Original X bytes".repeat(8192)
        const bodyY = "Current Y bytes".repeat(8192)
        const original = await RolloutArtifact.writeText(owner, bodyX, "text/plain")
        const latest = await RolloutArtifact.writeText(owner, bodyY, "text/plain")
        const part = MessageV2.AttachmentPart.parse({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: info.id,
          type: "attachment",
          mime: "text/plain",
          filename: "original.txt",
          url: "attachment://original",
          artifact: original,
        })
        await ScopeContext.provide({ scope, workspace: null, fn: () => Session.updatePart(part) })
        const remote = transport(session.id, binding)
        const start = () =>
          (exporter = startMemberSyncExporter({
            identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "device-repair" },
            connection: remote.connection,
            signal: new AbortController().signal,
          }))
        const live = start()
        await live.flush()
        await live.close()
        const batch = Batch.parse(await Storage.read(Keys.batch(binding.orgID, session.id)))
        expect(batch.events).toContainEqual(
          expect.objectContaining({ type: "attachment", attachmentID: part.id, hash: original.sha256 }),
        )
        await ScopeContext.provide({
          scope,
          workspace: null,
          fn: () => Session.updatePart({ ...part, artifact: latest }),
        })
        const bound = await nativeBinding(session.id, binding.orgID)
        if (!bound) throw new Error("Original native repair binding is missing")
        await pumpNativeSync(bound)
        const alias = AttachmentRecord.parse(await Storage.read(Keys.attachment(binding.orgID, session.id, part.id)))
        expect(alias.artifact).toEqual(latest)
        const key = Keys.attachmentContent(binding.orgID, session.id, part.id, original.sha256!, original.bytes)
        return {
          ...runtime,
          binding,
          session,
          scope,
          owner,
          original,
          latest,
          bodyX,
          bodyY,
          batch,
          alias,
          key,
          part,
          remote,
          start,
          async legacy() {
            // Historical aliases have no immutable content index; keep the actual native batch and both artifacts.
            await Storage.remove(key)
          },
          async maintenance() {
            const requestID = crypto.randomUUID()
            const lease = await RuntimeMaintenance.begin({
              purpose: "organization-backup",
              requestID,
              actor: {
                kind: "system",
                subjectID: "repair-operator",
                displayName: "Host operator",
                clientKind: "system",
                requestID,
              },
            })
            const receipt = await RuntimeMaintenance.drain(lease)
            return { lease, receipt }
          },
          async [Symbol.asyncDispose]() {
            try {
              await runtime.run(() => exporter?.close())
            } finally {
              try {
                await runtime.close()
              } finally {
                await service[Symbol.asyncDispose]()
              }
            }
          },
        }
      })
    } catch (error) {
      try {
        await runtime.run(() => exporter?.close())
      } finally {
        await runtime.close()
      }
      throw error
    }
  } catch (error) {
    await service[Symbol.asyncDispose]()
    throw error
  }
}

test("explicit native maintenance repairs the original lost-ACK X reference after its latest alias became Y", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await f.legacy()
    const before = {
      batch: await Storage.read(Keys.batch(f.binding.orgID, f.session.id)),
      alias: await Storage.read(Keys.attachment(f.binding.orgID, f.session.id, f.part.id)),
    }
    const { lease, receipt } = await f.maintenance()
    const tail = (await RuntimeMaintenance.status())!.tailRevision
    const sent = f.remote.received.length
    await invoke(lease, f.binding.orgID)
    const [repaired] = await Storage.readMany([f.key])
    expect(repaired).toBeDefined()
    const restored = AttachmentRecord.parse(repaired)
    expect(restored.artifact).toEqual(f.original)
    expect(await Storage.read(Keys.batch(f.binding.orgID, f.session.id))).toEqual(before.batch)
    expect(await Storage.read(Keys.attachment(f.binding.orgID, f.session.id, f.part.id))).toEqual(before.alias)
    expect(f.remote.received).toHaveLength(sent)
    expect((await RuntimeMaintenance.status())!.phase).toBe("draining")
    expect((await RuntimeMaintenance.status())!.tailRevision).toBeGreaterThan(tail)
    await expect(Storage.transaction(() => RuntimeMaintenance.assertDrained(lease, receipt))).rejects.toThrow(
      "draining tail",
    )
    let bytes = 0
    for await (const chunk of RolloutArtifact.read(f.owner, restored.artifact)) bytes += chunk.byteLength
    expect(bytes).toBe(Buffer.byteLength(f.bodyX))
    await invoke(lease, f.binding.orgID)
    expect(AttachmentRecord.parse(await Storage.read(f.key))).toEqual(restored)
    await RuntimeMaintenance.release(lease)
    f.remote.uploaded.length = 0
    await f.start().flush()
    expect(digest(Buffer.concat(f.remote.uploaded.map((bytes) => Buffer.from(bytes))))).toBe(f.original.sha256!)
    expect(await Storage.readMany([Keys.batch(f.binding.orgID, f.session.id)])).toEqual([undefined])
  })
})

test("explicit native maintenance preserves an already immutable fresh attachment reference", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const before = await Storage.read(f.key)
    const { lease } = await f.maintenance()
    await invoke(lease, f.binding.orgID)
    expect(await Storage.read(f.key)).toEqual(before)
    expect(await Storage.read(Keys.batch(f.binding.orgID, f.session.id))).toEqual(f.batch)
    await RuntimeMaintenance.release(lease)
  })
})

for (const failure of ["missing-alias", "foreign-only", "missing-bytes", "unproven-epoch"] as const)
  test(`explicit native attachment repair retains its original batch when evidence is ${failure}`, async () => {
    await using f = await fixture()
    await f.run(async () => {
      await f.legacy()
      if (failure === "missing-alias") await Storage.remove(Keys.attachment(f.binding.orgID, f.session.id, f.part.id))
      if (failure === "foreign-only") {
        const foreign = { kind: "operation" as const, scopeID: f.scope.id, operationID: crypto.randomUUID() }
        const ref = await RolloutArtifact.writeText(foreign, f.bodyX, "text/plain")
        expect(ref.sha256).toBe(f.original.sha256)
        await Storage.write([...RolloutArtifact.root(f.owner), "artifacts", f.original.id, "info"], {
          ...f.original,
          sha256: "f".repeat(64),
        })
      }
      if (failure === "missing-bytes")
        await Storage.write([...RolloutArtifact.root(f.owner), "artifacts", f.original.id, "chunks", "000000000000"], {
          sha256: "f".repeat(64),
          bytes: f.original.bytes,
        })
      if (failure === "unproven-epoch")
        await Storage.write(Keys.batch(f.binding.orgID, f.session.id), { ...f.batch, bindingEpoch: 2 })
      const before = await Storage.read(Keys.batch(f.binding.orgID, f.session.id))
      const { lease } = await f.maintenance()
      await expect(invoke(lease, f.binding.orgID)).rejects.toMatchObject({ data: { code: "UNKNOWN" } })
      expect(await Storage.read(Keys.batch(f.binding.orgID, f.session.id))).toEqual(before)
      expect(await Storage.readMany([f.key])).toEqual([undefined])
      expect((await RuntimeMaintenance.status())!.phase).toBe("draining")
      const bytes = await Storage.readBinary([...RolloutArtifact.root(f.owner), "blobs", f.original.sha256!])
      expect(digest(bytes)).toBe(f.original.sha256!)
      await RuntimeMaintenance.release(lease)
    })
  })

test("the central maintenance flag and a frozen lease cannot authorize original attachment repair", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await f.legacy()
    const original = await Storage.read(Keys.batch(f.binding.orgID, f.session.id))
    await expect(
      runMigrations({ targetDomain: "organization-sync", maintenance: true, output: "silent" }),
    ).rejects.toThrow()
    const { lease, receipt } = await f.maintenance()
    await RuntimeMaintenance.freeze(lease, receipt)
    await expect(invoke(lease, f.binding.orgID)).rejects.toThrow()
    expect(await Storage.read(Keys.batch(f.binding.orgID, f.session.id))).toEqual(original)
    expect(await Storage.readMany([f.key])).toEqual([undefined])
    expect((await RuntimeMaintenance.status())!.phase).toBe("frozen")
    await RuntimeMaintenance.release(lease)
  })
})

test("original attachment repair rejects another real organization selector before any native maintenance mutation", async () => {
  await using f = await fixture()
  await using other = await organizationFixture()
  expect(other.identity.orgID).not.toBe(f.binding.orgID)
  await f.run(async () => {
    await f.legacy()
    const { lease } = await f.maintenance()
    const proof = await NativeNamespaceIdentity.capture()
    expect(NativeNamespaceIdentity.inspect(proof)).toMatchObject({
      owner: "organization-runtime",
      identity: { orgID: f.binding.orgID, runtimeID: f.binding.driverRuntimeID },
    })
    const before = await RuntimeMaintenance.status()
    const batch = await Storage.read(Keys.batch(f.binding.orgID, f.session.id))
    await expect(invoke(lease, other.identity.orgID)).rejects.toMatchObject({ data: { code: "UNKNOWN" } })
    expect(await RuntimeMaintenance.status()).toEqual(before)
    expect(await Storage.read(Keys.batch(f.binding.orgID, f.session.id))).toEqual(batch)
    expect(await Storage.readMany([f.key])).toEqual([undefined])
    await NativeNamespaceIdentity.verify(proof)
    await RuntimeMaintenance.release(lease)
  })
})
