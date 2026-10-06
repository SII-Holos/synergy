import { afterAll, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistoryDisplay } from "../../src/session/history-display"
import { MessageV2 } from "../../src/session/message-v2"
import { migrations } from "../../src/session/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("historical reasoning projections rebuild lazily for only the selected owner without changing original Parts", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const migration = migrations.find((step) => step.id === "20261005-reasoning-display-identity")
        expect(migration?.upSession).toBeDefined()
        const seed = async () => {
          const session = await Session.create({})
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
            text: "Historical summary",
            time: { start: 1, end: 2 },
            metadata: { "openai-codex": { itemId: "rs_historical", reasoningEncryptedContent: "original" } },
          }
          await Session.updatePart(part)
          const summary = SessionHistoryDisplay.summarizePart(part)
          delete summary.reasoningKey
          await Storage.write(StoragePath.sessionDisplayPart(session.scope.id, session.id, messageID, part.id), summary)
          const key = ["sessions", session.scope.id, session.id, "display_parts_state", messageID]
          await Storage.write(key, { ready: true, generation: 1, cursor: part.id, sourceGeneration: 1 })
          return { session, messageID, part, key }
        }
        const current = await seed(),
          other = await seed()
        const owner = { scopeID: current.session.scope.id, sessionID: current.session.id }
        const original = await MessageV2.parts({ sessionID: current.session.id, messageID: current.messageID })
        await migration!.upSession!(owner, () => {})
        const invalidated = await Storage.read<Record<string, unknown>>(current.key)
        await migration!.upSession!(owner, () => {})
        expect(await Storage.read<Record<string, unknown>>(current.key)).toEqual(invalidated)
        expect(await Storage.read(other.key)).toMatchObject({ ready: true, generation: 1 })
        const page = await SessionHistoryDisplay.partPage(
          { sessionID: current.session.id, messageID: current.messageID },
          owner.scopeID,
        )
        expect(page.items[0].reasoningKey).toBe(JSON.stringify(["openai-codex", "rs_historical"]))
        expect(await MessageV2.parts({ sessionID: current.session.id, messageID: current.messageID })).toEqual(original)
        const imported: Record<string, unknown> = { ready: true, generation: 3, cursor: "stale", sourceGeneration: 3 }
        migration!.upgradeRecord!(current.key, imported)
        expect(imported).toEqual({ ready: false, generation: 4 })
        migration!.upgradeRecord!(current.key, imported)
        expect(imported).toEqual({ ready: false, generation: 4 })
      },
    })
  }))
