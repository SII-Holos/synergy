import { describe, expect, spyOn, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionMemoryPressure } from "../../src/session/memory-pressure"
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
        const lines = result.output.split("\n")
        const sessionLines = lines.filter((l: string) => /^\[ses_/.test(l))
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

  test("signals after releasing searched messages without choosing GC policy", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Collect" })
        await writeMessage(session.id, Identifier.ascending("message"), "searchable text", 100)

        using release = spyOn(SessionMemoryPressure, "signalRelease").mockImplementation(() => {})
        const tool = await SessionSearchTool.init()
        await tool.execute({ pattern: "searchable", scope: "current", limit: 10 }, ctx)

        expect(release).toHaveBeenCalledWith(expect.objectContaining({ phase: "tool.session_search.complete" }))
        for (const [input] of release.mock.calls) {
          expect(input).not.toHaveProperty("full")
          expect(input).not.toHaveProperty("forceFull")
        }
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

  test("limits to MAX_MATCHES_PER_SESSION matches per session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "PerSession" })
        for (let i = 0; i < 10; i++) {
          await writeMessage(session.id, Identifier.ascending("message"), `needle message ${i}`, 1000 - i * 10)
        }

        const tool = await SessionSearchTool.init()
        const result = await tool.execute({ pattern: "needle", scope: "current", limit: 10 }, ctx)

        expect(result.metadata.matches).toBe(3)
        expect(result.metadata.sessionsMatched).toBe(1)
      },
    })
  })

  test("handles limit=0 by returning no matches", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "LimitZero" })
        await writeMessage(session.id, Identifier.ascending("message"), "needle here", 100)

        const tool = await SessionSearchTool.init()
        const result = await tool.execute({ pattern: "needle", scope: "current", limit: 0 }, ctx)

        expect(result.metadata.matches).toBe(0)
        expect(result.title).toBe("No matches")
      },
    })
  })

  test("skips child sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({ title: "Parent" })
        const child = await Session.create({ title: "Child", parentID: parent.id })

        await writeMessage(parent.id, Identifier.ascending("message"), "needle in parent", 100)
        await writeMessage(child.id, Identifier.ascending("message"), "needle in child", 90)

        const tool = await SessionSearchTool.init()
        const result = await tool.execute({ pattern: "needle", scope: "current", limit: 10 }, ctx)

        expect(result.metadata.matches).toBe(1)
        expect(result.metadata.sessionsMatched).toBe(1)
      },
    })
  })

  test("skips archived sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const active = await Session.create({ title: "Active" })
        const archived = await Session.create({ title: "Archived" })

        await writeMessage(active.id, Identifier.ascending("message"), "needle in active", 100)
        await writeMessage(archived.id, Identifier.ascending("message"), "needle in archived", 90)

        await Session.update(archived.id, (draft) => {
          draft.time.archived = Date.now()
        })

        const tool = await SessionSearchTool.init()
        const result = await tool.execute({ pattern: "needle", scope: "current", limit: 10 }, ctx)

        expect(result.metadata.matches).toBe(1)
        expect(result.metadata.sessionsMatched).toBe(1)
      },
    })
  })

  test("handles no sessions in scope gracefully", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await SessionSearchTool.init()
        const result = await tool.execute({ pattern: "anything", scope: "current", limit: 10 }, ctx)

        expect(result.metadata.matches).toBe(0)
        expect(result.metadata.sessionsSearched).toBe(0)
        expect(result.metadata.candidateSessions).toBe(0)
        expect(result.title).toBe("No matches")
      },
    })
  })
})
