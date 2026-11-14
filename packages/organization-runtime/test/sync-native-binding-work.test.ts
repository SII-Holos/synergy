import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { registerSessionSchema } from "../src/session-schema"
import { binding, mutationBinding, Draft } from "../src/sync-outbox"
import { pumpNativeSync } from "../src/sync-native-source"
import { OrganizationSyncPath as Keys } from "../src/storage/path"

const original = {
  schemaVersion: 1,
  orgID: "native-read-work-org",
  projectID: "native-read-work-project",
  creatorID: "native-read-work-creator",
  driverRuntimeID: "native-read-work-runtime",
  bindingEpoch: 1,
} as const

test("one durable native delivery window bounds prewrite Session metadata reads while retaining every projected fact", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema(original) })
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
        const session = await Session.create({ organization: original, workspace: null, environmentID: null })
        const counts = {
          probe: { reads: 0, keys: 0, prewrite: 0 },
          native: { reads: 0, keys: 0, prewrite: 0 },
          delivery: { reads: 0, keys: 0, prewrite: 0 },
        }
        let phase: keyof typeof counts | undefined = "probe"
        const markerRoot = StoragePath.sessionMessageOrderMarkersRoot(
          Identifier.asScopeID(scope.id),
          Identifier.asSessionID(session.id),
        )
        let markerScans = 0
        const scan = Storage.scan
        using scans = spyOn(Storage, "scan").mockImplementation((prefix: string[]) => {
          if (
            phase === "native" &&
            prefix.length === markerRoot.length &&
            prefix.every((part, i) => part === markerRoot[i])
          )
            markerScans++
          return scan(prefix)
        })
        const readMany = Storage.readMany
        using reads = spyOn(Storage, "readMany").mockImplementation(<T>(keys: string[][]) => {
          const native = keys.filter(
            (key) =>
              (key[0] === "session_index" && key[1] === session.id) ||
              (key[0] === "sessions" &&
                key[1] === scope.id &&
                key[2] === session.id &&
                key[3] === "info" &&
                key.length === 4),
          )
          if (phase !== undefined && native.length) {
            const counter = counts[phase]
            counter.reads++
            counter.keys += native.length
            if (Storage.inWriteTransaction()) counter.prewrite++
          }
          return readMany<T>(keys)
        })
        const probes: Array<string | undefined> = []
        for (let index = 0; index < 32; index++)
          probes.push((await mutationBinding(session.id, original.orgID, scope.id))?.rootSessionID)
        phase = "native"
        let nativeTransactions = 0
        const seenTransactions = new WeakSet<object>()
        const windows: Array<{ messages: number; markerScans: number; metadataReads: number; elapsedMs: number }> = []
        const messages: string[] = []
        const parts: string[] = []
        for (let offset = 0; offset < 32; offset += 16) {
          const started = performance.now()
          const beforeScans = markerScans
          const beforeReads = counts.native.reads
          await Storage.transaction(async (tx) => {
            if (!seenTransactions.has(tx)) {
              seenTransactions.add(tx)
              nativeTransactions++
            }
            for (let index = offset; index < offset + 16; index++) {
              const messageID = Identifier.ascending("message")
              const partID = Identifier.ascending("part")
              messages.push(messageID)
              parts.push(partID)
              await Session.updateMessage({
                id: messageID,
                sessionID: session.id,
                role: "user",
                agent: "binding-work-fixture",
                model: { providerID: "fixture", modelID: "bounded-native-binding" },
                time: { created: index + 1 },
              })
              await Session.updatePart({
                id: partID,
                sessionID: session.id,
                messageID,
                type: "text",
                text: `Original native delivery ${index}`,
              })
            }
          })
          windows.push({
            messages: 16,
            markerScans: markerScans - beforeScans,
            metadataReads: counts.native.reads - beforeReads,
            elapsedMs: performance.now() - started,
          })
        }
        phase = undefined
        const owner = await binding(session.id, original.orgID)
        if (!owner) throw new Error("The original native owner is missing")
        const pending = await Storage.query({ kind: "event_delivery", limit: 128 })
        expect(pending.length).toBeGreaterThanOrEqual(64)
        expect(pending.length).toBeLessThanOrEqual(128)
        phase = "delivery"
        await pumpNativeSync(owner)
        phase = undefined
        const actualReads = counts.delivery.reads
        const actualKeys = counts.delivery.keys
        const actualPrewrite = counts.delivery.prewrite
        expect(await Storage.query({ kind: "event_delivery", limit: 128 })).toEqual([])
        const drafts = (await Storage.query({ prefix: Keys.drafts(original.orgID, session.id), limit: 128 })).map(
          (row) => Draft.parse(row.value),
        )
        expect(
          drafts.flatMap((draft) => (draft.event.type === "message" ? [draft.event.messageID] : [])).sort(),
        ).toEqual(messages.toSorted())
        expect(drafts.flatMap((draft) => (draft.event.type === "part" ? [draft.event.partID] : [])).sort()).toEqual(
          parts.toSorted(),
        )
        console.error(
          "NATIVE_BINDING_READ_WORK",
          JSON.stringify({
            deliveries: pending.length,
            drafts: drafts.length,
            metadataReads: actualReads,
            metadataKeys: actualKeys,
            prewriteMetadataReads: actualPrewrite,
          }),
        )
        console.error(
          "NATIVE_BINDING_COMBINED_WORK",
          JSON.stringify({ nativeTransactions, markerScans, windows, counts }),
        )
        expect(actualPrewrite).toBeLessThanOrEqual(32)
        expect(nativeTransactions).toBe(2)
        expect(markerScans).toBe(2)
        expect(windows.map((window) => window.markerScans)).toEqual([1, 1])
        expect(probes).toEqual(Array(32).fill(session.id))
        expect(counts.probe.reads).toBeLessThanOrEqual(64)
        expect(counts.probe.keys).toBe(128)
        await expect(mutationBinding(session.id, original.orgID, "another-scope")).rejects.toThrow("Scope")
      },
    })
  })
})
