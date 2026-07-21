import { describe, expect, mock, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

function legacyMessageID(value: number) {
  return `msg_${value.toString(16).padStart(26, "0")}`
}

async function writeUser(sessionID: string, id: string, created: number) {
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    agent: "synergy",
    model: { providerID: "test", modelID: "test" },
    time: { created },
    isRoot: true,
    rootID: id,
    visible: true,
    origin: { type: "user" },
  })
}

async function writeAssistant(input: { sessionID: string; id: string; rootID: string; created: number; cwd: string }) {
  await Session.updateMessage({
    id: input.id,
    sessionID: input.sessionID,
    role: "assistant",
    time: { created: input.created, completed: input.created },
    parentID: input.rootID,
    rootID: input.rootID,
    modelID: "test",
    providerID: "test",
    mode: "build",
    agent: "synergy",
    path: { cwd: input.cwd, root: input.cwd },
    summary: false,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  } satisfies MessageV2.Assistant)
}

describe("session message cursor pages", () => {
  test("walks backward from the latest page in canonical storage order", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Cursor chronology" })
        const ids = [15, 1, 14, 2, 13].map(legacyMessageID)
        for (const [index, id] of ids.entries()) {
          await writeUser(session.id, id, 1_000 + index)
        }

        const latest = await Session.messagePage({ sessionID: session.id, limit: 2 })
        expect(latest.items.map((message) => message.info.id)).toEqual(ids.slice(3))
        expect(latest.referencedRoots).toEqual([])
        expect(latest.total).toBe(5)
        expect(latest.hasMore).toBe(true)
        expect(latest.nextCursor).toBeString()

        const middle = await Session.messagePage({
          sessionID: session.id,
          limit: 2,
          cursor: latest.nextCursor!,
        })
        expect(middle.items.map((message) => message.info.id)).toEqual(ids.slice(1, 3))
        expect(middle.referencedRoots).toEqual([])
        expect(middle.total).toBe(5)
        expect(middle.hasMore).toBe(true)
        expect(middle.nextCursor).toBeString()

        const oldest = await Session.messagePage({
          sessionID: session.id,
          limit: 2,
          cursor: middle.nextCursor!,
        })
        expect(oldest.items.map((message) => message.info.id)).toEqual(ids.slice(0, 1))
        expect(oldest.referencedRoots).toEqual([])
        expect(oldest.total).toBe(5)
        expect(oldest.hasMore).toBe(false)
        expect(oldest.nextCursor).toBeNull()

        await Session.remove(session.id)
      },
    })
  })

  test("keeps referenced roots outside page boundaries and cursor accounting", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Cursor roots" })
        const rootID = Identifier.ascending("message")
        await Session.updateMessage({
          id: rootID,
          sessionID: session.id,
          role: "user",
          time: { created: 1_000 },
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
          isRoot: true,
          rootID,
          visible: true,
          origin: { type: "user" },
        })

        const assistantIDs = [2_000, 3_000, 4_000].map(() => Identifier.ascending("message"))
        for (const [index, id] of assistantIDs.entries()) {
          await writeAssistant({
            sessionID: session.id,
            id,
            rootID,
            created: 2_000 + index,
            cwd: tmp.path,
          })
        }

        const latest = await Session.messagePage({ sessionID: session.id, limit: 2 })
        expect(latest.items.map((message) => message.info.id)).toEqual(assistantIDs.slice(1))
        expect(latest.referencedRoots.map((message) => message.info.id)).toEqual([rootID])
        expect(latest.items).toHaveLength(2)
        expect(latest.total).toBe(4)
        expect(latest.hasMore).toBe(true)

        const older = await Session.messagePage({
          sessionID: session.id,
          limit: 2,
          cursor: latest.nextCursor!,
        })
        expect(older.items.map((message) => message.info.id)).toEqual([rootID, assistantIDs[0]])
        expect(older.referencedRoots).toEqual([])
        expect(older.hasMore).toBe(false)
        expect(older.nextCursor).toBeNull()

        await Session.remove(session.id)
      },
    })
  })

  test("flushes buffered streaming parts before returning a page snapshot", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Buffered message page" })
        const rootID = Identifier.ascending("message")
        const assistantID = Identifier.ascending("message")
        try {
          await writeUser(session.id, rootID, 1_000)
          await writeAssistant({ sessionID: session.id, id: assistantID, rootID, created: 2_000, cwd: tmp.path })
          const part: MessageV2.TextPart = {
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: assistantID,
            type: "text",
            text: "buffered text",
          }
          await Session.updatePartDelta(part, part.text)

          const latest = await Session.messagePage({ sessionID: session.id, limit: 2 })

          expect(latest.items.find((item) => item.info.id === assistantID)?.parts).toContainEqual(
            expect.objectContaining({ id: part.id, text: part.text }),
          )
        } finally {
          await Session.flushPartWrites(session.id)
          await Session.remove(session.id)
        }
      },
    })
  })

  test("does not hydrate parts outside the requested page", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalParts = MessageV2.parts
    const loadedMessageIDs: string[] = []
    ;(MessageV2.parts as any) = mock(async (input: Parameters<typeof MessageV2.parts>[0]) => {
      loadedMessageIDs.push(input.messageID)
      return originalParts(input)
    })

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ title: "Bounded page hydration" })
          const ids = [1, 2, 3, 4].map((value) => legacyMessageID(value))
          for (const [index, id] of ids.entries()) {
            await writeUser(session.id, id, 1_000 + index)
          }

          const latest = await Session.messagePage({ sessionID: session.id, limit: 2 })

          expect(latest.items.map((message) => message.info.id)).toEqual(ids.slice(2))
          expect(latest.total).toBe(4)
          expect(latest.hasMore).toBe(true)
          expect(loadedMessageIDs).toEqual(ids.slice(2))

          await Session.remove(session.id)
        },
      })
    } finally {
      ;(MessageV2.parts as any) = originalParts
    }
  })

  test("rejects malformed, unsupported, and stale cursors", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Cursor errors" })
        const ids = [1, 2, 3].map((value) => legacyMessageID(value))
        for (const [index, id] of ids.entries()) {
          await writeUser(session.id, id, 1_000 + index)
        }

        for (const cursor of [
          "not-a-cursor",
          Buffer.from(JSON.stringify({ v: 2, a: ids[1], d: "before" })).toString("base64url"),
        ]) {
          let invalid: unknown
          try {
            await Session.messagePage({ sessionID: session.id, limit: 2, cursor })
          } catch (error) {
            invalid = error
          }
          expect(invalid).toBeInstanceOf(SessionHistory.MessagePageCursorInvalidError)
        }

        const latest = await Session.messagePage({ sessionID: session.id, limit: 2 })
        expect(latest.nextCursor).toBeString()
        await Session.removeMessage({ sessionID: session.id, messageID: latest.items[0]!.info.id })

        let stale: unknown
        try {
          await Session.messagePage({
            sessionID: session.id,
            limit: 2,
            cursor: latest.nextCursor!,
          })
        } catch (error) {
          stale = error
        }
        expect(stale).toBeInstanceOf(SessionHistory.MessagePageCursorStaleError)

        await Session.remove(session.id)
      },
    })
  })
})
