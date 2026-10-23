import { afterAll, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { ContinuationKernel } from "../../src/session/continuation-kernel"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test.each([64, 512, 2478, 5000])(
  "finite reads stay within selected bodies across %i historical messages",
  (count) =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const owner = {
            scopeID: Identifier.asScopeID(session.scope.id),
            sessionID: Identifier.asSessionID(session.id),
          }
          const rows: Array<{ key: string[]; value: unknown }> = []
          const ids: string[] = []
          for (let index = 0; index < count; index++) {
            const id = Identifier.ascending("message")
            const part = {
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: id,
              type: "text" as const,
              text: `message ${index} ` + "historical body ".repeat(100),
            }
            const info = MessageV2.deriveSemantics([
              {
                info: {
                  id,
                  sessionID: session.id,
                  role: "user" as const,
                  agent: "test",
                  model: { providerID: "test", modelID: "test" },
                  time: { created: index },
                },
                parts: [part],
              },
            ])[0].info
            ids.push(id)
            rows.push(
              { key: StoragePath.messageInfo(owner.scopeID, owner.sessionID, id), value: info },
              { key: StoragePath.messagePart(owner.scopeID, owner.sessionID, id, part.id), value: part },
            )
          }
          for (let offset = 0; offset < rows.length; offset += 256)
            await Storage.transaction((tx) => tx.writeMany(rows.slice(offset, offset + 256)))
          await SessionHistory.modelMessageInfos({ sessionID: session.id })
          using parts = spyOn(MessageV2, "parts")
          using binary = spyOn(Storage, "readBinary")
          using queries = spyOn(Storage, "query")
          const selected = await SessionHistory.messages({ sessionID: session.id, limit: 24 })
          expect(selected.map((message) => message.info.id)).toEqual(ids.slice(-24))
          expect(parts).toHaveBeenCalledTimes(24)
          expect(binary).not.toHaveBeenCalled()
          expect(queries.mock.calls.length).toBeLessThan(count + 256)
          parts.mockClear()
          await Session.updateLastExchange(session.id)
          const latest = selected.at(-1)!
          const text = latest.parts[0]
          expect((await Session.get(session.id)).lastExchange?.user).toBe(
            text.type === "text" ? text.text.slice(0, 200) : undefined,
          )
          expect(parts).not.toHaveBeenCalled()
          await ContinuationKernel.propose(session.id)
          if (latest.info.role !== "user") throw new Error("Expected input")
          const segment = await RolloutLifecycle.start(session, latest.info, latest.parts)
          await RolloutLifecycle.finishSegment(segment, "completed")
          expect(parts.mock.calls.length).toBeLessThanOrEqual(2)
          expect(parts.mock.calls.every(([input]) => input.messageID === latest.info.id)).toBe(true)
          expect(binary).not.toHaveBeenCalled()
        },
      })
    }),
  60000,
)
