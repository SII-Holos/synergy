import { afterAll, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { MigrationRegistry } from "../../src/migration/registry"
import { upgradeImportedRecord } from "../../src/migration/import"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistoryDisplay } from "../../src/session/history-display"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("a prepared historical reasoning index upgrades within its owner and preserves canonical evidence", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const other = await Session.create({})
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          time: { created: 1 },
        })
        const part: MessageV2.ReasoningPart = {
          id: Identifier.ascending("part"),
          messageID,
          sessionID: session.id,
          type: "reasoning",
          text: "",
          time: { start: 1, end: 2 },
          metadata: { "test-provider": { reasoningEncryptedContent: "opaque-evidence" } },
        }
        await Session.updatePart(part)
        const stateKey = ["sessions", session.scope.id, session.id, "display_parts_state", messageID]
        const foreignKey = ["sessions", other.scope.id, other.id, "display_parts_state", messageID]
        const state = { ready: true, generation: 7, cursor: part.id, sourceGeneration: 7, retained: "metadata" }
        await Storage.write(stateKey, state)
        await Storage.write(foreignKey, state)
        await Storage.write(StoragePath.sessionDisplayPart(session.scope.id, session.id, messageID, part.id), {
          ...MessageV2.summarizePart(part),
          render: true,
        })
        const migration = MigrationRegistry.list()
          .get("session")!
          .find((item) => item.id === "20261005-session-reasoning-display")
        expect(migration).toBeDefined()
        await migration!.upSession!({ scopeID: session.scope.id, sessionID: session.id }, () => {})
        const invalidated = await Storage.read<Record<string, unknown>>(stateKey)
        expect(invalidated).toEqual({ ready: false, generation: 8, retained: "metadata" })
        await migration!.upSession!({ scopeID: session.scope.id, sessionID: session.id }, () => {})
        expect(await Storage.read<Record<string, unknown>>(stateKey)).toEqual(invalidated)
        expect(await Storage.read<Record<string, unknown>>(foreignKey)).toEqual(state)
        expect(
          (await SessionHistoryDisplay.partPage({ sessionID: session.id, messageID }, session.scope.id)).items[0]
            .render,
        ).toBe(false)
        expect(await MessageV2.parts({ sessionID: session.id, messageID })).toEqual([part])
        const imported: Record<string, unknown> = { ...state }
        migration!.upgradeRecord!(stateKey, imported)
        expect(imported).toEqual(invalidated)
        expect(upgradeImportedRecord(stateKey, state)).toEqual(invalidated)
        expect(state.ready).toBe(true)
        const preparing = { ready: false, generation: 3, cursor: part.id, sourceGeneration: 3 }
        expect(upgradeImportedRecord(stateKey, preparing)).toEqual({ ready: false, generation: 4 })
        await Session.remove(session.id)
        await Session.remove(other.id)
      },
    })
  }))
