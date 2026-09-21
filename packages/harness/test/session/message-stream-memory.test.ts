import { describe, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

async function writeMessage(sessionID: string, id: string, text: string, created: number) {
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "synergy",
    model: { providerID: "test", modelID: "test" },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: id,
    type: "text",
    text,
    origin: "user",
  })
}

describe("MessageV2.stream memory", () => {
  test("orders legacy IDs without hydrating every message before the first yield", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await writeMessage(session.id, Identifier.ascending("message"), "first", 1)
          await writeMessage(session.id, `msg_${"f".repeat(26)}`, "legacy", 2)
          await writeMessage(session.id, Identifier.ascending("message"), "third", 3)
          const newestID = Identifier.ascending("message")
          await writeMessage(session.id, newestID, "newest", 4)

          using parts = spyOn(MessageV2, "parts")
          const iterator = MessageV2.stream({
            scopeID: ScopeContext.current.scope.id,
            sessionID: session.id,
          })[Symbol.asyncIterator]()
          const first = await iterator.next()
          await iterator.return?.()

          expect(first.value?.info.id).toBe(newestID)
          expect(first.value?.parts).toEqual([expect.objectContaining({ type: "text", text: "newest" })])
          expect(parts.mock.calls.map(([input]) => input.messageID)).toEqual([newestID])
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
