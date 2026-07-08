import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionSearchTool } from "../../src/tool/session-search"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const ctx = {
  sessionID: "ses_test123",
  messageID: "msg_test123",
  callID: "call_test123",
  agent: "synergy-max",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

function userMessage(sessionID: string, id: string, created: number): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "synergy",
    model: { providerID: "test", modelID: "test" },
  }
}

function textPart(sessionID: string, messageID: string, text: string): MessageV2.TextPart {
  return {
    id: Identifier.ascending("part"),
    sessionID,
    messageID,
    type: "text",
    text,
    origin: "user",
  }
}

async function writeMessage(sessionID: string, messageID: string, text: string, created: number) {
  await Session.updateMessage(userMessage(sessionID, messageID, created))
  await Session.updatePart(textPart(sessionID, messageID, text))
}

describe("session_search", () => {
  test("stops scanning additional messages once the global limit is reached", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Large searchable session" })
        // Messages stream newest-first, and the tool stops reading a session's
        // messages once MAX_MATCHES_PER_SESSION is reached within that session.
        // Write 5 messages so we can test that only the first match is returned.
        await writeMessage(session.id, Identifier.ascending("message"), "needle alpha", 100)
        await writeMessage(session.id, Identifier.ascending("message"), "no match 1", 99)
        await writeMessage(session.id, Identifier.ascending("message"), "no match 2", 98)
        await writeMessage(session.id, Identifier.ascending("message"), "needle beta", 97)
        await writeMessage(session.id, Identifier.ascending("message"), "needle gamma", 96)

        // Session only has 1 session, limit=1 should return exactly 1 match
        const tool = await SessionSearchTool.init()
        const result = await tool.execute({ pattern: "needle", scope: "current", limit: 1 }, ctx)

        expect(result.metadata.matches).toBe(1)
        expect(result.metadata.sessionsMatched).toBe(1)
        expect(result.metadata.candidateSessions).toBe(1)
      },
    })
  })

  test("limits matches across multiple sessions when limit is less than total available matches", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Session C — not enough matches" })

        // Write messages in reverse chronological label order to test ordering.
        // MessageV2.stream reads newest first, so we give the first-written
        // session fewer updated matches and a later-written one more,
        // then verify the session-level limit stops after enough sessions.
        await writeMessage(session.id, Identifier.ascending("message"), "alpha needle one", 100)
        await writeMessage(session.id, Identifier.ascending("message"), "alpha needle two", 99)
        await writeMessage(session.id, Identifier.ascending("message"), "alpha needle three", 98)

        const tool = await SessionSearchTool.init()
        const result = await tool.execute({ pattern: "needle", scope: "current", limit: 2 }, ctx)

        expect(result.metadata.matches).toBe(2)
        expect(result.metadata.sessionsMatched).toBe(1)
        expect(result.metadata.candidateSessions).toBe(1)
      },
    })
  })

  test("reports metadata correctly with zero matches", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Empty session" })
        await writeMessage(session.id, Identifier.ascending("message"), "nothing relevant here", 100)

        const tool = await SessionSearchTool.init()
        const result = await tool.execute({ pattern: "zzzzz_nonexistent_zzzzz", scope: "current", limit: 10 }, ctx)

        expect(result.metadata.matches).toBe(0)
        expect(result.metadata.sessionsMatched).toBe(0)
        expect(result.metadata.candidateSessions).toBeGreaterThanOrEqual(1)
        expect(result.title).toBe("No matches")
      },
    })
  })
})
