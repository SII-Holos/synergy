import { expect, spyOn, test } from "bun:test"
import { randomBytes, createHash } from "node:crypto"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { StorageEventSinks } from "@ericsanchezok/synergy-harness/storage/event-sinks"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { observeSqliteWriters } from "@ericsanchezok/synergy-harness/test/support/storage-runtime"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { registerSessionSchema } from "../src/session-schema"
import { binding as nativeBinding } from "../src/sync-outbox"
import { nativeSyncFaults, pumpNativeSync } from "../src/sync-native-source"
import { startMemberSyncExporter } from "../src/sync-exporter"
import type { MemberConnection } from "../src/connection"

const original = {
  schemaVersion: 1,
  orgID: "native-full-org",
  projectID: "native-full-project",
  creatorID: "native-full-creator",
  driverRuntimeID: "native-full-runtime",
  bindingEpoch: 1,
} as const
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

test("an original native write failing FULL before its commit fact reports blockage and requires pending ACK before content", async () => {
  using writer = observeSqliteWriters()
  await using runtime = await testRuntime({ register: () => registerSessionSchema(original) })
  writer.stopObserving()
  await runtime.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: original.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const session = await Session.create({ organization: original, workspaceID: null, environmentID: null })
        const message = MessageV2.User.parse({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: 1 },
          agent: PrimaryAgentIdentity.names.general,
          model: { providerID: "fixture", modelID: "fixture" },
        })
        await Session.updateMessage(message)
        const bound = await nativeBinding(session.id, original.orgID)
        if (!bound) throw new Error("Original native binding is unavailable")
        await pumpNativeSync(bound)
        expect(await Storage.query({ kind: "event_delivery" })).toEqual([])
        const before = digest(
          await MessageV2.readInfo({ scopeID: scope.id, sessionID: session.id, messageID: message.id }),
        )
        let committedFacts = 0
        const capture = StorageEventSinks.capture
        using facts = spyOn(StorageEventSinks, "capture").mockImplementation((tx, event) => {
          if (event.type === MessageV2.Event.Updated.type) committedFacts++
          return capture(tx, event)
        })
        let failure: unknown
        await writer.withMaxPageCount(Storage.current().store, async () => {
          try {
            await Session.updateMessage({
              ...message,
              summary: { title: randomBytes(1024 * 1024).toString("base64"), diffs: [] },
            })
          } catch (error) {
            failure = error
          }
        })
        expect(failure && typeof failure === "object" && "code" in failure ? failure.code : undefined).toBe(
          "SQLITE_FULL",
        )
        expect(committedFacts).toBe(0)
        expect(
          digest(await MessageV2.readInfo({ scopeID: scope.id, sessionID: session.id, messageID: message.id })),
        ).toBe(before)
        await Session.updateMessage({
          ...message,
          summary: { title: "Native healthy control", diffs: [] },
        })
        expect(committedFacts).toBe(1)
        expect(nativeSyncFaults()).toContainEqual(
          expect.objectContaining({ rootSessionID: session.id, binding: original, reason: "storage_full" }),
        )
        const effects: string[] = []
        let nextSeq = 1
        let state: Sync.Share["syncState"] = "pending"
        const connection: Pick<MemberConnection, "connected" | "syncState" | "observeSync" | "sync" | "uploadBlob"> = {
          connected: {
            type: "handshake",
            protocolVersion: 1,
            orgID: original.orgID,
            deploymentIncarnation: "native-full-deployment",
            runtimeID: original.driverRuntimeID,
            connectionEpoch: 1,
            syncVersion: Sync.observationVersion,
            signingIdentity: {
              schemaVersion: 1,
              orgID: original.orgID,
              deploymentIncarnation: "native-full-deployment",
              keyID: "native-full-key",
              publicKey: "a".repeat(64),
            },
            heartbeatMs: 10,
            offlineMs: 100,
          },
          async syncState() {
            return {
              sessionID: session.id,
              shareState: "shared",
              shareGeneration: 1,
              bindingEpoch: 1,
              nextSeq,
              syncState: state,
              updatedAt: 1,
            }
          },
          async observeSync(sessionID, input) {
            expect(sessionID).toBe(session.id)
            expect(input).toMatchObject({ bindingEpoch: 1, shareGeneration: 1, nextSeq })
            state = input.state
            effects.push(input.state)
            return {
              sessionID,
              shareState: "shared",
              shareGeneration: 1,
              bindingEpoch: 1,
              nextSeq,
              syncState: state,
              updatedAt: 1,
            }
          },
          async sync(batch) {
            effects.push("content")
            nextSeq = batch.lastSeq + 1
            return { sessionID: session.id, bindingEpoch: 1, shareGeneration: 1, nextSeq, syncState: "synced" }
          },
          async uploadBlob() {
            throw new Error("No native blob is selected by this fixture")
          },
        }
        const exporter = startMemberSyncExporter({
          identity: { orgID: original.orgID, accountID: original.creatorID, deviceID: "native-full-device" },
          connection,
          signal: new AbortController().signal,
        })
        try {
          await exporter.flush()
          expect(effects.slice(0, 3)).toEqual(["blocked", "pending", "content"])
          expect(nativeSyncFaults()).toEqual([])
        } finally {
          await exporter.close()
        }
      },
    })
  })
})
