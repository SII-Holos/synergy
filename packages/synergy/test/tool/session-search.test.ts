import { describe, expect, spyOn, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
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

type SearchParams = {
  pattern: string
  scope: "all" | "current" | "project" | "home"
  scopeID?: string
  includeChildren: boolean
  timeField: "session" | "message"
  content: "text" | "tool" | "all"
  since?: string
  before?: string
  limit: number
}

type Tool = Awaited<ReturnType<typeof SessionSearchTool.init>>

async function run(tool: Tool, pattern: string, extra: Partial<SearchParams> = {}) {
  const params: SearchParams = {
    pattern,
    scope: "current",
    includeChildren: false,
    timeField: "session",
    content: "text",
    limit: 10,
    ...extra,
  }
  return tool.execute(params as never, ctx)
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
  test("returns at most limit matches across sessions under a tight global limit", async () => {
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
        const result = await run(tool, "needle", { limit: 1 })

        expect(result.metadata.matches).toBe(1)
        expect(result.metadata.sessionsMatched).toBe(1)
        const lines = result.output.split("\n")
        const sessionLines = lines.filter((l: string) => /^\[ses_/.test(l))
        expect(sessionLines.length).toBe(1)
      },
    })
  })

  test("older session with stronger matches outranks a newer session with weak matches", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // The old session contains messages carrying BOTH pattern tokens
        // ("deploy|hotfix" -> overlap 2) but was last touched long ago.
        const oldSession = await Session.create({ title: "Old Strong" })
        await writeMessage(oldSession.id, Identifier.ascending("message"), "deploy the hotfix runbook", 5000)
        // The new session contains only weak single-token matches but was
        // updated most recently.
        const newSession = await Session.create({ title: "New Weak" })
        await writeMessage(newSession.id, Identifier.ascending("message"), "please deploy now", Date.now())
        await writeMessage(newSession.id, Identifier.ascending("message"), "deploy after lunch", Date.now())

        const tool = await SessionSearchTool.init()
        const result = await run(tool, "deploy|hotfix", { limit: 1 })

        expect(result.metadata.matches).toBe(1)
        expect(result.output).toContain(oldSession.id)
        expect(result.output).not.toContain(newSession.id)
      },
    })
  })

  test("scopeID must resolve to a real project scope, never Home or an unknown id", async () => {
    await using tmp = await tmpdir({ git: true })
    const projectScope = await tmp.scope()
    await ScopeContext.provide({
      scope: projectScope,
      fn: async () => {
        const session = await Session.create({ title: "Pinned" })
        await writeMessage(session.id, Identifier.ascending("message"), "pin needle", Date.now())

        const tool = await SessionSearchTool.init()

        // Home's scope id is "home"; pinning it as a "project" must not search
        // Home sessions while reporting scopeSearched: ["project"].
        const home = await run(tool, "needle", { scope: "project", scopeID: "home", limit: 50 })
        expect(home.title).toBe("No project scope found")
        expect(home.metadata.rejected).toBe("unknown-scope")

        // A nonexistent project id is rejected the same way.
        const missing = await run(tool, "needle", { scope: "project", scopeID: "d_does_not_exist", limit: 50 })
        expect(missing.title).toBe("No project scope found")

        // A real project id still works.
        const pinned = await run(tool, "needle", { scope: "project", scopeID: projectScope.id, limit: 50 })
        expect(pinned.metadata.matches).toBeGreaterThanOrEqual(1)
        expect(pinned.output).toContain(session.id)
      },
    })
  })

  test("content all matches attachments nested in completed tool state", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Tool Attachment" })
        const messageID = Identifier.ascending("message")
        await writeMessage(session.id, messageID, "plain body text", Date.now())
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "tool",
          callID: Identifier.ascending("tool"),
          tool: "test_tool",
          state: {
            status: "completed",
            input: {},
            output: "tool done",
            title: "Test Tool",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
            attachments: [
              {
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID,
                type: "attachment",
                mime: "image/png",
                filename: "toolimage-unique-7c4d.png",
                url: "file:///toolimage-unique-7c4d.png",
              } satisfies MessageV2.AttachmentPart,
            ],
          },
        } as MessageV2.Part)

        const tool = await SessionSearchTool.init()

        const byText = await run(tool, "toolimage-unique-7c4d")
        expect(byText.metadata.matches).toBe(0)

        const byAll = await run(tool, "toolimage-unique-7c4d", { content: "all" })
        expect(byAll.metadata.matches).toBeGreaterThanOrEqual(1)
      },
    })
  })

  test("regex guard accepts safe alternations and noncapturing groups, rejects ambiguous ones", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Regex Guard" })
        await writeMessage(session.id, Identifier.ascending("message"), "aaaa".repeat(500), Date.now())

        const tool = await SessionSearchTool.init()

        const rejections: Array<[string, string]> = [
          ["(a+)+$", "nested quantifier"],
          ["(a|aa)+$", "ambiguous alternation (prefix overlap)"],
          ["(a|aab)+$", "ambiguous alternation (prefix overlap)"],
          ["(|a)+$", "empty alternative overlaps every branch"],
          ["(?:a+)+$", "nested quantifier inside noncapturing group"],
        ]
        for (const [pattern, why] of rejections) {
          const result = await run(tool, pattern)
          expect(result.title, `${pattern}: ${why}`).toBe("Invalid pattern")
        }

        // Safe shapes must not be rejected: disjoint alternatives and plain
        // quantified noncapturing groups.
        for (const pattern of ["(?:error|warning)+", "(foo|bar)+", "(?:deploy)+", "(a|b|c)+"]) {
          const result = await run(tool, pattern)
          expect(result.title, `${pattern} should be accepted`).not.toBe("Invalid pattern")
        }
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
        const result = await run(tool, "zzzzz_nonexistent")

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
        await run(tool, "searchable")

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
        const result = await run(tool, "needle")

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
        const result = await run(tool, "needle")

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
        const result = await run(tool, "needle", { limit: 0 })

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
        const result = await run(tool, "needle")

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
        const result = await run(tool, "needle")

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
        const result = await run(tool, "anything")

        expect(result.metadata.matches).toBe(0)
        expect(result.metadata.sessionsSearched).toBe(0)
        expect(result.metadata.candidateSessions).toBe(0)
        expect(result.title).toBe("No matches")
      },
    })
  })

  test("searches Home scope sessions by default and honors project/home/project+scopeID scope selection", async () => {
    await using tmp = await tmpdir({ git: true })
    const projectScope = await tmp.scope()

    const homeSession = await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ title: "Home Search" })
        await writeMessage(session.id, Identifier.ascending("message"), "home needle alphaUnique99", Date.now())
        return session
      },
    })
    const projectSession = await ScopeContext.provide({
      scope: projectScope,
      fn: async () => {
        const session = await Session.create({ title: "Project Search" })
        await writeMessage(session.id, Identifier.ascending("message"), "project needle betaUnique99", Date.now())
        return session
      },
    })

    await ScopeContext.provide({
      scope: projectScope,
      fn: async () => {
        const tool = await SessionSearchTool.init()

        // scope=all: both Home and project sessions are searched.
        const all = await run(tool, "needle", { scope: "all", limit: 50 })
        expect(all.output).toContain(homeSession.id)
        expect(all.output).toContain(projectSession.id)
        expect(all.metadata.scopeSearched).toEqual(expect.arrayContaining(["home", "project"]))

        // scope=project: project sessions only, never Home.
        const project = await run(tool, "needle", { scope: "project", limit: 50 })
        expect(project.output).not.toContain(homeSession.id)
        expect(project.output).toContain(projectSession.id)

        // scope=home: Home sessions only.
        const home = await run(tool, "needle", { scope: "home", limit: 50 })
        expect(home.output).toContain(homeSession.id)
        expect(home.output).not.toContain(projectSession.id)
        expect(home.metadata.scopeSearched).toEqual(["home"])
      },
    })
  })

  test("scopeID pins search to a single project scope", async () => {
    await using tmpA = await tmpdir({ git: true })
    const scopeA = await tmpA.scope()
    await using tmpB = await tmpdir({ git: true })
    const scopeB = await tmpB.scope()

    const sessionA = await ScopeContext.provide({
      scope: scopeA,
      fn: async () => {
        const session = await Session.create({ title: "Pinned A" })
        await writeMessage(session.id, Identifier.ascending("message"), "pinNeedle uniqueA77", Date.now())
        return session
      },
    })
    const sessionB = await ScopeContext.provide({
      scope: scopeB,
      fn: async () => {
        const session = await Session.create({ title: "Pinned B" })
        await writeMessage(session.id, Identifier.ascending("message"), "pinNeedle uniqueB77", Date.now())
        return session
      },
    })

    await ScopeContext.provide({
      scope: scopeA,
      fn: async () => {
        const tool = await SessionSearchTool.init()

        const pinned = await run(tool, "pinNeedle", { scope: "project", scopeID: scopeB.id, limit: 50 })
        expect(pinned.output).toContain(sessionB.id)
        expect(pinned.output).not.toContain(sessionA.id)

        const allProjects = await run(tool, "pinNeedle", { scope: "project", limit: 50 })
        expect(allProjects.output).toContain(sessionA.id)
        expect(allProjects.output).toContain(sessionB.id)
      },
    })
  })

  test("includeChildren searches child sessions when enabled", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({ title: "Parent" })
        const child = await Session.create({ title: "Child", parentID: parent.id })
        await writeMessage(child.id, Identifier.ascending("message"), "childOnly tokenZz9", Date.now())

        const tool = await SessionSearchTool.init()

        const skipped = await run(tool, "childOnly")
        expect(skipped.metadata.matches).toBe(0)

        const included = await run(tool, "childOnly", { includeChildren: true })
        expect(included.metadata.matches).toBeGreaterThanOrEqual(1)
        expect(included.output).toContain(child.id)
      },
    })
  })

  test("timeField message filters by message creation time instead of session update time", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Time Field" })
        // Ancient message creation; the session itself was updated just now.
        await writeMessage(session.id, Identifier.ascending("message"), "ancient needle msgTimeTkn", 100)

        const since = new Date(Date.now() - 60_000).toISOString()
        const tool = await SessionSearchTool.init()

        // Default timeField=session: session.updated (now) is >= since, so the
        // session is a candidate and the ancient message is found.
        const bySession = await run(tool, "msgTimeTkn", { since })
        expect(bySession.metadata.matches).toBeGreaterThanOrEqual(1)

        // timeField=message: message.created (100) is < since, so no match.
        const byMessage = await run(tool, "msgTimeTkn", { since, timeField: "message" })
        expect(byMessage.metadata.matches).toBe(0)
      },
    })
  })

  test("content tool searches tool payloads while default text does not", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Tool Content" })
        const messageID = Identifier.ascending("message")
        await writeMessage(session.id, messageID, "plain body text", Date.now())
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "tool",
          callID: Identifier.ascending("tool"),
          tool: "test_tool",
          state: {
            status: "completed",
            input: { query: "toolInputTknX9" },
            output: "tool output token toolOutputTknX9",
            title: "Test Tool",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        } as MessageV2.Part)

        const tool = await SessionSearchTool.init()

        const byText = await run(tool, "toolInputTknX9")
        expect(byText.metadata.matches).toBe(0)

        const byTool = await run(tool, "toolInputTknX9", { content: "tool" })
        expect(byTool.metadata.matches).toBeGreaterThanOrEqual(1)
      },
    })
  })

  test("content all matches attachment filenames and URLs", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Attachment Content" })
        const messageID = Identifier.ascending("message")
        await writeMessage(session.id, messageID, "plain body text", Date.now())
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "attachment",
          mime: "application/pdf",
          filename: "specfile-unique-9a2b.pdf",
          url: "file:///specfile-unique-9a2b.pdf",
        } as MessageV2.Part)

        const tool = await SessionSearchTool.init()

        const byText = await run(tool, "specfile-unique-9a2b")
        expect(byText.metadata.matches).toBe(0)

        const byAll = await run(tool, "specfile-unique-9a2b", { content: "all" })
        expect(byAll.metadata.matches).toBeGreaterThanOrEqual(1)
      },
    })
  })

  test("keeps higher-relevance older matches over newer weak matches within the per-session cap", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Ranking" })
        const strongOld1 = Identifier.ascending("message")
        const strongOld2 = Identifier.ascending("message")
        const weakNew1 = Identifier.ascending("message")
        const weakNew2 = Identifier.ascending("message")
        const weakNew3 = Identifier.ascending("message")

        // Strong matches contain both alternatives ("deploy|hotfix" -> overlap 2).
        await writeMessage(session.id, strongOld1, "deploy the hotfix runbook now", 5000)
        await writeMessage(session.id, strongOld2, "hotfix deploy procedure attached", 4000)
        // Weak matches contain only one alternative (overlap 1) but are newer.
        await writeMessage(session.id, weakNew1, "just deploy it quickly", 9000)
        await writeMessage(session.id, weakNew2, "please deploy after review", 8000)
        await writeMessage(session.id, weakNew3, "deploy is fine", 7000)

        const tool = await SessionSearchTool.init()
        const result = await run(tool, "deploy|hotfix")

        expect(result.metadata.matches).toBe(3)
        expect(result.output).toContain(strongOld1)
        expect(result.output).toContain(strongOld2)
      },
    })
  })

  test("rejects potentially catastrophic regex patterns with guidance instead of executing", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Regex Guard" })
        await writeMessage(session.id, Identifier.ascending("message"), "aaaa".repeat(500), Date.now())

        const tool = await SessionSearchTool.init()
        const result = await run(tool, "(a+)+$")

        expect(result.title).toBe("Invalid pattern")
        expect(String(result.output).length).toBeGreaterThan(0)
      },
    })
  })
})
