import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"

function user(sessionID: string, created: number): MessageV2.User {
  return {
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "order-concurrency-fixture",
    model: { providerID: "fixture", modelID: "native-order" },
    time: { created },
  }
}

test("parallel public Message writes followed by a sequential write retain every native message in the same transaction stream", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const seed = user(session.id, 1)
        const a = user(session.id, 2)
        const b = user(session.id, 3)
        const final = user(session.id, 4)
        await Session.updateMessage(seed)
        await Array.fromAsync(MessageV2.stream({ sessionID: session.id }))
        await Storage.transaction(async () => {
          await Session.updateMessage(seed)
          await Promise.all([Session.updateMessage(a), Session.updateMessage(b)])
          await Session.updateMessage(final)
          for (const message of [seed, a, b, final])
            expect(
              await MessageV2.readInfo({
                scopeID: session.scope.id,
                sessionID: session.id,
                messageID: message.id,
              }),
            ).toMatchObject({ id: message.id, time: message.time })
          const streamed = await Array.fromAsync(MessageV2.stream({ sessionID: session.id }))
          expect(streamed.map((message) => message.info.id)).toEqual([final.id, b.id, a.id, seed.id])
        })
        const committed = await Array.fromAsync(MessageV2.stream({ sessionID: session.id }))
        expect(committed.map((message) => message.info.id)).toEqual([final.id, b.id, a.id, seed.id])
      },
    }),
  )
})
