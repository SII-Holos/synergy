import { afterAll, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

async function fixture(fn: (session: Session.Info, root: MessageV2.User, reply: MessageV2.Assistant) => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({})
      const id = Identifier.ascending("message")
      const root: MessageV2.User = {
        id,
        rootID: id,
        isRoot: true,
        sessionID: session.id,
        role: "user",
        origin: { type: "user" },
        visible: true,
        includeInContext: true,
        agent: "test",
        model: { providerID: "test", modelID: "test" },
        time: { created: 10_000 },
      }
      const reply: MessageV2.Assistant = {
        id: Identifier.ascending("message"),
        sessionID: session.id,
        parentID: id,
        rootID: id,
        role: "assistant",
        agent: "test",
        mode: "test",
        modelID: "test",
        providerID: "test",
        time: { created: 10_001, completed: 10_002 },
        finish: "stop",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      await Session.updateMessage(root)
      await Session.updateMessage(reply)
      await fn(session, root, reply)
    },
  })
}

for (const count of [500, 5_000]) {
  test(
    `turn summaries and target hydration never read bodies from ${count} older messages`,
    () =>
      runtime.run(() =>
        fixture(async (session, root, reply) => {
          const scopeID = Identifier.asScopeID(session.scope.id)
          const sessionID = Identifier.asSessionID(session.id)
          await Storage.transaction(async () => {
            for (let index = 0; index < count; index++) {
              const id = Identifier.ascending("message")
              await Storage.write(StoragePath.messageInfo(scopeID, sessionID, id), {
                ...root,
                id,
                rootID: id,
                time: { created: index + 1 },
              })
              const partID = Identifier.ascending("part")
              await Storage.write(StoragePath.messagePart(scopeID, sessionID, id, partID), {
                id: partID,
                sessionID,
                messageID: id,
                type: "text",
                text: "Unrelated historical body",
              })
            }
          })
          await SessionHistory.prepareDisplay(session.id)
          using bodies = spyOn(MessageV2, "parts")
          const infos = await SessionHistory.turnInfos({ sessionID, rootID: root.id })
          expect(infos.map((info) => info.id)).toEqual([root.id, reply.id])
          expect(bodies).not.toHaveBeenCalled()
          const messages = await SessionHistory.turnMessages({ sessionID, rootID: root.id })
          expect(messages.map((message) => message.info)).toEqual(infos)
          expect(bodies.mock.calls.map(([input]) => input.messageID)).toEqual([root.id, reply.id])
        }),
      ),
    60_000,
  )
}

test("turn summaries share deletion, rollback, chronology and root isolation with full messages", () =>
  runtime.run(() =>
    fixture(async (session, root, reply) => {
      const otherID = Identifier.ascending("message")
      await Session.updateMessage({ ...root, id: otherID, rootID: otherID, time: { created: 10_001 } })
      const later = { ...reply, id: Identifier.ascending("message"), time: { created: 10_003, completed: 10_004 } }
      await Session.updateMessage(later)
      const input = { sessionID: session.id, rootID: root.id }
      expect((await SessionHistory.turnInfos(input)).map((info) => info.id)).toEqual([root.id, reply.id, later.id])
      await Session.removeMessage({ sessionID: session.id, messageID: reply.id })
      const historyID = Identifier.ascending("history")
      await Storage.write(
        StoragePath.sessionHistoryEvent(
          Identifier.asScopeID(session.scope.id),
          Identifier.asSessionID(session.id),
          historyID,
        ),
        {
          id: historyID,
          sessionID: session.id,
          type: "rollback",
          time: { created: 10_005 },
          numTurns: 1,
          cutMessageID: later.id,
          droppedMessageIDs: [later.id],
          droppedUserMessageIDs: [],
          files: [],
          patchPartIDs: [],
        } satisfies SessionHistory.RollbackEvent,
      )
      const infos = await SessionHistory.turnInfos(input)
      expect(infos.map((info) => info.id)).toEqual([root.id])
      expect((await SessionHistory.turnMessages(input)).map((message) => message.info)).toEqual(infos)
      await Session.removeMessage({ sessionID: session.id, messageID: root.id })
      await expect(SessionHistory.turnInfos(input)).rejects.toBeInstanceOf(Storage.NotFoundError)
    }),
  ))

test("cancelled turn reads do not hydrate any body", () =>
  runtime.run(() =>
    fixture(async (session, root) => {
      using bodies = spyOn(MessageV2, "parts")
      const input = { sessionID: session.id, rootID: root.id, signal: AbortSignal.abort() }
      await expect(SessionHistory.turnInfos(input)).rejects.toThrow()
      await expect(SessionHistory.turnMessages(input)).rejects.toThrow()
      expect(bodies).not.toHaveBeenCalled()
    }),
  ))
