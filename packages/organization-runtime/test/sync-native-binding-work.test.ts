import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { registerSessionSchema } from "../src/session-schema"
import { binding, Draft } from "../src/sync-outbox"
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
        const messages: string[] = []
        const parts: string[] = []
        for (let offset = 0; offset < 32; offset += 16)
          await Storage.transaction(async () => {
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
        const owner = await binding(session.id, original.orgID)
        if (!owner) throw new Error("The original native owner is missing")
        const pending = await Storage.query({ kind: "event_delivery", limit: 128 })
        expect(pending.length).toBeGreaterThanOrEqual(64)
        expect(pending.length).toBeLessThanOrEqual(128)
        const readMany = Storage.readMany
        let metadataReads = 0
        let metadataKeys = 0
        let prewriteMetadataReads = 0
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
          if (native.length) {
            metadataReads++
            metadataKeys += native.length
            if (Storage.inWriteTransaction()) prewriteMetadataReads++
          }
          return readMany<T>(keys)
        })
        await pumpNativeSync(owner)
        const actualReads = metadataReads
        const actualKeys = metadataKeys
        const actualPrewrite = prewriteMetadataReads
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
        expect(actualPrewrite).toBeLessThanOrEqual(32)
      },
    })
  })
})
