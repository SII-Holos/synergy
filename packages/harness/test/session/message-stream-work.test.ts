import { expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { prepareSessionMigrations } from "../../src/migration"
import { testRuntime } from "../support/runtime"

test("a prepared native message stream reads ordered header windows without a writer or a full marker scan", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const ids: string[] = []
        for (let offset = 0; offset < 129; offset += 32)
          await Storage.transaction(async () => {
            for (let index = offset; index < Math.min(offset + 32, 129); index++) {
              const id = Identifier.ascending("message")
              ids.push(id)
              await Session.updateMessage({
                id,
                sessionID: session.id,
                role: "user",
                agent: "general",
                model: { providerID: "fixture", modelID: "bounded-native-stream" },
                time: { created: index + 1 },
              })
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: id,
                type: "text",
                text: `Native message ${index}`,
              })
            }
          })
        await Session.flushPartWrites(session.id)
        await prepareSessionMigrations({ scopeID: session.scope.id, sessionID: session.id })
        using writer = spyOn(Storage.current().store, "transaction")
        using scans = spyOn(Storage, "scan")
        using headers = spyOn(Storage, "childKeys")
        const actual: string[] = []
        for await (const message of MessageV2.stream({ sessionID: session.id })) {
          actual.push(message.info.id)
          expect(message.parts).toHaveLength(1)
          expect(message.parts[0]).toMatchObject({ type: "text", text: `Native message ${128 - actual.length + 1}` })
        }
        expect(actual).toEqual(ids.toReversed())
        expect(writer).not.toHaveBeenCalled()
        const root = StoragePath.sessionMessageOrderMarkersRoot(
          Identifier.asScopeID(session.scope.id),
          Identifier.asSessionID(session.id),
        )
        expect(scans.mock.calls.some(([key]) => JSON.stringify(key) === JSON.stringify(root))).toBe(false)
        const windows = headers.mock.calls.filter(([input]) => JSON.stringify(input.prefix) === JSON.stringify(root))
        expect(windows.length).toBeGreaterThan(1)
        expect(windows.every(([input]) => input.limit !== undefined && input.limit <= 128)).toBe(true)
      },
    }),
  )
}, 15000)
