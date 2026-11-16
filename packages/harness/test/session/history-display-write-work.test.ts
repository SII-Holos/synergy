import { expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistoryDisplay } from "../../src/session/history-display"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { StorageMutationGuard } from "../../src/storage/mutation-guard"
import { StoragePath } from "../../src/storage/path"
import type { SqlQueryOptions, SqlRow, SqlValue } from "../../src/storage/sql-contract"
import { testRuntime } from "../support/runtime"

function user(sessionID: string, created: number): MessageV2.User {
  return {
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "display-work-fixture",
    model: { providerID: "fixture", modelID: "display-work" },
    time: { created },
  }
}
function text(message: MessageV2.User): MessageV2.TextPart {
  return {
    id: Identifier.ascending("part"),
    sessionID: message.sessionID,
    messageID: message.id,
    type: "text",
    text: `original text ${message.time.created}`,
  }
}
function owner(session: Session.Info, message: MessageV2.User) {
  return { scopeID: session.scope.id, sessionID: session.id, messageID: message.id }
}
async function expectRejected(work: Promise<unknown>, expected: Error) {
  const outcome = await work.then(
    () => ({ kind: "resolved" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  )
  expect(outcome.kind).toBe("rejected")
  if (outcome.kind === "rejected") expect(outcome.error).toBe(expected)
}

// Count actual SQL dispatches, forwarding every statement to the original writer.
test("native Message and Part publication bounds display row write dispatches while retaining exact projections", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const messages = Array.from({ length: 16 }, (_, index) => user(session.id, index + 1))
        const parts = messages.map(text)
        const mutations = { message: 0, part: 0 }
        const calls = { message: 0, part: 0 }
        let phase: keyof typeof mutations | undefined
        const messageWritten = SessionHistoryDisplay.messageWritten
        const partWritten = SessionHistoryDisplay.partWritten
        using message = spyOn(SessionHistoryDisplay, "messageWritten").mockImplementation(async (...args) => {
          const previous = phase
          phase = "message"
          calls.message++
          try {
            return await messageWritten(...args)
          } finally {
            phase = previous
          }
        })
        using part = spyOn(SessionHistoryDisplay, "partWritten").mockImplementation(async (...args) => {
          const previous = phase
          phase = "part"
          calls.part++
          try {
            return await partWritten(...args)
          } finally {
            phase = previous
          }
        })
        await Storage.transaction(async (tx) => {
          const connection = tx.raw
          const query = connection.query
          using sql = spyOn(connection, "query").mockImplementation(
            <Row extends SqlRow = SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions) => {
              if (
                phase &&
                /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(statement) &&
                /\bstorage_(?:nodes|records)\b/i.test(statement)
              )
                mutations[phase]++
              return query<Row>(statement, values, options)
            },
          )
          for (const [index, message] of messages.entries()) {
            await Session.updateMessage(message)
            await Session.updatePart(parts[index])
          }
        })
        const timeline = await SessionHistoryDisplay.timelinePage(
          { sessionID: session.id, limit: 100 },
          { hidden: new Set() },
          session.scope.id,
        )
        expect(timeline.items.map((item) => item.info.id)).toEqual(messages.map((message) => message.id))
        expect(timeline.total).toBe(messages.length)
        expect(timeline.generation).toBe(messages.length)
        for (const [index, message] of messages.entries()) {
          const page = await SessionHistoryDisplay.partPage(
            { sessionID: session.id, messageID: message.id },
            session.scope.id,
          )
          expect(page.items.map((part) => part.id)).toEqual([parts[index].id])
          expect(page.generation).toBe(1)
          expect(await MessageV2.parts(owner(session, message))).toEqual([parts[index]])
          expect(
            await Storage.readMany([
              StoragePath.sessionTextDirty(session.scope.id, session.id, message.id, parts[index].id),
            ]),
          ).toEqual([
            {
              key: StoragePath.messagePart(
                Identifier.asScopeID(session.scope.id),
                Identifier.asSessionID(session.id),
                Identifier.asMessageID(message.id),
                Identifier.asPartID(parts[index].id),
              ),
            },
          ])
        }
        expect(calls).toEqual({ message: messages.length, part: parts.length })
        console.info("NATIVE_DISPLAY_ROW_WRITE_WORK", JSON.stringify({ messages: messages.length, calls, mutations }))
        expect(mutations.message).toBeLessThanOrEqual(messages.length * 4)
        expect(mutations.part).toBeLessThanOrEqual(parts.length * 4)
      },
    }),
  )
})

test("display bulk publication retains fresh native write guards and rolls canonical rows back at the original COMMIT", async () => {
  let sessionID: string | undefined
  const authority = ["display-write-work-owner"]
  const denied = new Error("display owner revoked")
  const commitDenied = new Error("original final display COMMIT guard")
  await using runtime = await testRuntime({
    register() {
      StorageMutationGuard.register("display-write-work-owner", async (tx, keys) => {
        if (
          !keys.some(
            (key) =>
              key[0] === "sessions" && key[1] === "home" && key[2] === sessionID && key[3]?.startsWith("display_"),
          )
        )
          return
        const [current] = await tx.readMany<{ enabled: boolean }>([authority])
        if (!current?.enabled) throw denied
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        sessionID = session.id
        await Storage.write(authority, { enabled: true })
        const original = user(session.id, 1)
        const originalPart = text(original)
        await Session.updateMessage(original)
        await Session.updatePart(originalPart)
        const rejected = user(session.id, 2)
        await expectRejected(
          Storage.transaction(async () => {
            await Storage.write(authority, { enabled: false })
            await Session.updateMessage(rejected)
          }),
          denied,
        )
        const rejectedPart = { ...originalPart, id: Identifier.ascending("part"), text: "rejected native text" }
        await expectRejected(
          Storage.transaction(async () => {
            await Storage.write(authority, { enabled: false })
            await Session.updatePart(rejectedPart)
          }),
          denied,
        )
        const commitRejected = user(session.id, 3)
        const commitPart = text(commitRejected)
        await expectRejected(
          Storage.transaction(
            async () => {
              await Session.updateMessage(commitRejected)
              await Session.updatePart(commitPart)
            },
            {
              commitGuard() {
                throw commitDenied
              },
            },
          ),
          commitDenied,
        )
        const scopeID = Identifier.asScopeID(session.scope.id)
        const sid = Identifier.asSessionID(session.id)
        expect(
          await Storage.readMany([
            StoragePath.messageInfo(scopeID, sid, Identifier.asMessageID(rejected.id)),
            StoragePath.messageInfo(scopeID, sid, Identifier.asMessageID(commitRejected.id)),
            StoragePath.messagePart(
              scopeID,
              sid,
              Identifier.asMessageID(original.id),
              Identifier.asPartID(rejectedPart.id),
            ),
            StoragePath.messagePart(
              scopeID,
              sid,
              Identifier.asMessageID(commitRejected.id),
              Identifier.asPartID(commitPart.id),
            ),
          ]),
        ).toEqual([undefined, undefined, undefined, undefined])
        expect(await Storage.readMany([authority])).toEqual([{ enabled: true }])
        const timeline = await SessionHistoryDisplay.timelinePage(
          { sessionID: session.id },
          { hidden: new Set() },
          session.scope.id,
        )
        expect(timeline.items.map((item) => item.info.id)).toEqual([original.id])
        expect(timeline.total).toBe(1)
        expect(timeline.generation).toBe(1)
        const page = await SessionHistoryDisplay.partPage(
          { sessionID: session.id, messageID: original.id },
          session.scope.id,
        )
        expect(page.items.map((part) => part.id)).toEqual([originalPart.id])
        expect(page.generation).toBe(1)
        expect(await MessageV2.parts(owner(session, original))).toEqual([originalPart])
      },
    }),
  )
})
