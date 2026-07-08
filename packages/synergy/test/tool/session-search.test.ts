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
  test("stops scanning sessions once the global limit is reached with many sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // Create 3 sessions, each with 1 match. limit=1 should return 1 session, 1 match.
        const sessionA = await Session.create({ title: "A" })
        const sessionB = await Session.create({ title: "B" })
        const sessionC = await Session.create({ title: "C" })

        await writeMessage(sessionA.id, Identifier.ascending("message"), "needle in A", 100)
        await writeMessage(sessionB.id, Identifier.ascending("message"), "needle in B", 90)
        await writeMessage(sessionC.id, Identifier.ascending("message"), "needle in C", 80)

        const tool = await SessionSearchTool.init()
        const result = await tool.execute({ pattern: "needle", scope: "current", limit: 1 }, ctx)

        expect(result.metadata.matches).toBe(1)
        expect(result.metadata.sessionsMatched).toBe(1)
        // With limit=1, session_search should stop after 1 match across all sessions
        // Only one session's data should appear in the output
        const lines = result.output.split("\n")
        const sessionLines = lines.filter((l: string) => /\[ses_/.test(l))
        expect(sessionLines.length).toBe(1)
      },
    })
  })

  test("returns no matches when no text contains the pattern", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Empty" })
        await writeMessage(session.id, Identifier.ascending("message"), "nothing here", 100)

        const tool = await SessionSearchTool.init()
        const result = await tool.execute({ pattern: "zzzzz_nonexistent", scope: "current", limit: 10 }, ctx)

        expect(result.metadata.matches).toBe(0)
        expect(result.metadata.sessionsMatched).toBe(0)
        expect(result.title).toBe("No matches")
      },
    })
  })

  test("reports metadata shape correctly", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Meta Check" })
        await writeMessage(session.id, Identifier.ascending("message"), "needle one", 100)
        await writeMessage(session.id, Identifier.ascending("message"), "needle two", 90)

        const tool = await SessionSearchTool.init()
        const result = await tool.execute({ pattern: "needle", scope: "current", limit: 10 }, ctx)

        expect(result.metadata).toHaveProperty("sessionsSearched")
        expect(result.metadata).toHaveProperty("sessionsMatched")
        expect(result.metadata).toHaveProperty("candidateSessions")
        expect(result.metadata).toHaveProperty("matches")
        const totalMatches = result.metadata.matches as number
        expect(totalMatches).toBeGreaterThanOrEqual(1)
        expect(totalMatches).toBeLessThanOrEqual(10)
      },
    })
  })
})
