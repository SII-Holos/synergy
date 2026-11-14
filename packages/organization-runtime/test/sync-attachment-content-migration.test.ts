import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  OrganizationSessionProtocol as Sessions,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { StorageRetention } from "../../harness/src/storage/retention"
import { registerSessionSchema } from "../src/session-schema"
import { startMemberSyncExporter } from "../src/sync-exporter"
import { AttachmentRecord } from "../src/sync-projection"
import { OrganizationSyncPath as Keys } from "../src/storage/path"
import type { MemberConnection } from "../src/connection"

const migrationID = "20261114-organization-sync-attachment-content"
const binding: Sessions.Binding = {
  schemaVersion: 1,
  orgID: "attachment-migration-org",
  projectID: "attachment-migration-project",
  creatorID: "attachment-migration-creator",
  driverRuntimeID: "attachment-migration-runtime",
  bindingEpoch: 1,
}
function transport(sessionID: string) {
  const batches: Sync.Batch[] = []
  let nextSeq = 1
  const connection: Pick<MemberConnection, "connected" | "sync" | "syncState" | "uploadBlob" | "observeSync"> = {
    connected: {
      type: "handshake",
      protocolVersion: 1,
      orgID: binding.orgID,
      deploymentIncarnation: "attachment-migration-deployment",
      runtimeID: binding.driverRuntimeID,
      connectionEpoch: 1,
      syncVersion: Sync.observationVersion,
      signingIdentity: {
        schemaVersion: 1,
        orgID: binding.orgID,
        deploymentIncarnation: "attachment-migration-deployment",
        keyID: "attachment-migration-key",
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
      batches.push(structuredClone(batch))
      nextSeq = batch.lastSeq + 1
      return { sessionID, shareGeneration: 1, bindingEpoch: 1, nextSeq, syncState: "synced" }
    },
  }
  return { connection, batches }
}

async function acknowledgedAttachment() {
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
  const message = MessageV2.User.parse({
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "user",
    time: { created: 2 },
    agent: "fixture",
    model: { providerID: "fixture", modelID: "model" },
  })
  await ScopeContext.provide({ scope, workspace: null, fn: () => Session.updateMessage(message) })
  const owner = { kind: "session", scopeID: scope.id, sessionID: session.id } as const
  const artifact = await RolloutArtifact.writeText(owner, "Original acknowledged attachment".repeat(64), "text/plain")
  if (!artifact.sha256) throw new Error("Original artifact did not record its content hash")
  const partID = Identifier.ascending("part")
  await ScopeContext.provide({
    scope,
    workspace: null,
    fn: () =>
      Session.updatePart({
        id: partID,
        sessionID: session.id,
        messageID: message.id,
        type: "attachment",
        mime: "text/plain",
        filename: "acknowledged.txt",
        url: "attachment://acknowledged",
        artifact,
      }),
  })
  const remote = transport(session.id)
  const exporter = startMemberSyncExporter({
    identity: { orgID: binding.orgID, accountID: binding.creatorID, deviceID: "attachment-migration-device" },
    connection: remote.connection,
    signal: new AbortController().signal,
  })
  try {
    await exporter.flush()
    expect(remote.batches.flatMap((batch) => batch.events)).toContainEqual(
      expect.objectContaining({ type: "attachment", attachmentID: partID, hash: artifact.sha256 }),
    )
    expect((await Storage.readMany([Keys.batch(binding.orgID, session.id)]))[0]).toBeUndefined()
    expect(await Storage.list(Keys.drafts(binding.orgID, session.id))).toEqual([])
  } finally {
    await exporter.close()
  }
  const aliasKey = Keys.attachment(binding.orgID, session.id, partID)
  const contentKey = Keys.attachmentContent(binding.orgID, session.id, partID, artifact.sha256, artifact.bytes)
  const alias = AttachmentRecord.parse(await Storage.read(aliasKey))
  expect(alias.artifact).toEqual(artifact)
  expect(await Storage.read(contentKey)).toEqual(alias)
  return { scope, session, owner, artifact, alias, aliasKey, contentKey }
}

async function resetOnlyContentMigration(contentKey: string[]) {
  await Storage.transaction(async () => {
    await Storage.remove(contentKey)
    const key = StoragePath.metaMigrationLogDomain("organization-sync")
    const receipts = await Storage.read<Record<string, number>>(key)
    expect(receipts[migrationID]).toEqual(expect.any(Number))
    delete receipts[migrationID]
    await Storage.write(key, receipts)
  })
}

async function fixture() {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "attachment-content-upgrade-"))
  const open = () => testRuntime({ home, register: () => registerSessionSchema(binding) })
  const runtime = await open()
  return {
    runtime,
    open,
    async [Symbol.asyncDispose]() {
      await runtime.close()
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

for (const removal of ["session", "rollout"] as const) {
  test(`startup preserves an acknowledged alias after original ${removal} removal without inventing content`, async () => {
    await using f = await fixture()
    const original = await f.runtime.run(async () => {
      const original = await acknowledgedAttachment()
      if (removal === "session") {
        await ScopeContext.provide({
          scope: original.scope,
          workspace: null,
          fn: () => Session.remove(original.session.id),
        })
        const pair = await Storage.readMany([
          StoragePath.sessionIndex(Identifier.asSessionID(original.session.id)),
          StoragePath.sessionInfo(Identifier.asScopeID(original.scope.id), Identifier.asSessionID(original.session.id)),
        ])
        expect(pair).toEqual([undefined, undefined])
      } else {
        const DAY = 24 * 60 * 60 * 1000
        const report = await StorageRetention.run({
          retentionMs: 7 * DAY,
          maxBytes: 0,
          liveSessionIDs: [],
          now: Date.now() + 30 * DAY,
        })
        expect(report.pruned.map((value) => value.key)).toContainEqual(RolloutArtifact.root(original.owner))
        expect(await Session.get(original.session.id)).toMatchObject({ id: original.session.id })
      }
      await expect(RolloutArtifact.get(original.owner, original.artifact.id)).rejects.toBeInstanceOf(
        Storage.NotFoundError,
      )
      expect(await Storage.read(original.aliasKey)).toEqual(original.alias)
      await resetOnlyContentMigration(original.contentKey)
      return original
    })
    await f.runtime.close()
    await using reopened = await f.open()
    await reopened.run(async () => {
      expect(await Storage.read(original.aliasKey)).toEqual(original.alias)
      expect((await Storage.readMany([original.contentKey]))[0]).toBeUndefined()
      const receipts = await Storage.read<Record<string, number>>(
        StoragePath.metaMigrationLogDomain("organization-sync"),
      )
      expect(receipts[migrationID]).toEqual(expect.any(Number))
    })
  })
}

for (const damage of ["half-pair", "missing-body"] as const) {
  test(`startup still rejects an acknowledged alias with ${damage} instead of treating corruption as removal`, async () => {
    await using f = await fixture()
    await f.runtime.run(async () => {
      const original = await acknowledgedAttachment()
      await resetOnlyContentMigration(original.contentKey)
      if (damage === "half-pair") {
        await Storage.remove(StoragePath.sessionIndex(Identifier.asSessionID(original.session.id)))
        expect(
          (
            await Storage.readMany([
              StoragePath.sessionInfo(
                Identifier.asScopeID(original.scope.id),
                Identifier.asSessionID(original.session.id),
              ),
            ])
          )[0],
        ).toBeDefined()
      } else {
        await Storage.removeTree([...RolloutArtifact.root(original.owner), "blobs"])
        expect(await RolloutArtifact.get(original.owner, original.artifact.id)).toEqual(original.artifact)
      }
    })
    await f.runtime.close()
    const failure = await f.open().then(
      async (runtime) => {
        await runtime.close()
        return undefined
      },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
  })
}
