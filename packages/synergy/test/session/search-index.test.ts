import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionSearchIndex } from "../../src/session/search-index"
import { SessionSearchTool } from "../../src/tool/session-search"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const ctx = {
  sessionID: "ses_test_p2",
  messageID: "msg_test_p2",
  callID: "call_test_p2",
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

function textPart(
  sessionID: string,
  messageID: string,
  text: string,
  origin: "user" | "system" = "user",
): MessageV2.TextPart {
  return {
    id: Identifier.ascending("part"),
    sessionID,
    messageID,
    type: "text",
    text,
    origin,
  }
}

async function writeMessage(sessionID: string, messageID: string, text: string, created = Date.now()) {
  await Session.updateMessage(userMessage(sessionID, messageID, created))
  await Session.updatePart(textPart(sessionID, messageID, text))
}

function scopeIDOf(session: Session.Info): Identifier.ScopeID {
  return Identifier.asScopeID((session.scope as { id: string }).id)
}

describe("session.search-index", () => {
  test("tokenizes mixed zh/en identifiers and CJK into deterministic tokens", async () => {
    const tokens = SessionSearchIndex.tokenize("authFlow_v2 机器学习 done")
    expect(tokens).toContain("authflow_v2")
    expect(tokens).toContain("done")
    // CJK run becomes overlapping bigrams.
    expect(tokens).toContain("机器")
    expect(tokens).toContain("器学")
    expect(tokens).toContain("学习")

    // overlapScore is 0 when no pattern token is present, positive otherwise.
    expect(SessionSearchIndex.overlapScore("机器学习", ["机器"])).toBe(1)
    expect(SessionSearchIndex.overlapScore("plain text", ["missing"])).toBe(0)
    expect(SessionSearchIndex.overlapScore("authFlow_v2", ["authflow_v2", "gone"])).toBe(1)
  })

  test("updateMessage marks the session dirty and rebuildSession clears it while persisting text", async () => {
    await using tmp = await tmpdir({ git: true })
    const projectScope = await tmp.scope()
    await ScopeContext.provide({
      scope: projectScope,
      fn: async () => {
        const session = await Session.create({ title: "Dirty Mark" })
        await writeMessage(session.id, Identifier.ascending("message"), "dirtyNeedle text content", Date.now())

        const scopeID = scopeIDOf(session)
        const sessionID = Identifier.asSessionID(session.id)

        expect(await SessionSearchIndex.isDirty(scopeID, sessionID)).toBe(true)

        const record = await SessionSearchIndex.rebuildSession(scopeID, sessionID)
        expect(record.messages.length).toBe(1)
        expect(record.messages[0]!.text).toContain("dirtyNeedle")
        expect(await SessionSearchIndex.isDirty(scopeID, sessionID)).toBe(false)

        // A later write marks dirty again.
        await writeMessage(session.id, Identifier.ascending("message"), "second needle", Date.now())
        expect(await SessionSearchIndex.isDirty(scopeID, sessionID)).toBe(true)
      },
    })
  })

  test("system text and reasoning/compaction parts never enter the text index", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Part Kinds" })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage(userMessage(session.id, messageID, Date.now()))
        await Session.updatePart(textPart(session.id, messageID, "user visible text", "user"))
        await Session.updatePart(textPart(session.id, messageID, "hidden system injection needle", "system"))
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "reasoning",
          text: "reasoning should not be searchable needle",
          time: { start: Date.now(), end: Date.now() },
        } as MessageV2.Part)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "compaction",
          auto: true,
        } as MessageV2.Part)

        const scopeID = scopeIDOf(session)
        const record = await SessionSearchIndex.rebuildSession(scopeID, Identifier.asSessionID(session.id))
        expect(record.messages[0]!.text).toContain("user visible text")
        expect(record.messages[0]!.text).not.toContain("hidden system")
        expect(record.messages[0]!.text).not.toContain("reasoning should")
      },
    })
  })

  test("oversized tool output is capped and flagged truncated in the record", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Tool Cap" })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage(userMessage(session.id, messageID, Date.now()))
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "tool",
          callID: Identifier.ascending("tool"),
          tool: "test_tool",
          state: {
            status: "completed",
            input: { q: "x" },
            output: "headToken " + "y".repeat(20_000),
            title: "Test",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        } as MessageV2.Part)

        const scopeID = scopeIDOf(session)
        const record = await SessionSearchIndex.rebuildSession(scopeID, Identifier.asSessionID(session.id))
        const entry = record.messages[0]!
        expect(entry.tool).toContain("headToken")
        expect(entry.toolTruncated).toBe(true)
        expect(entry.tool!.length).toBeLessThanOrEqual(16 * 1024)
      },
    })
  })

  test("removeMessage and removePart mark dirty; Session.remove deletes records without ghosts", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Remove Paths" })
        const keepID = Identifier.ascending("message")
        const dropID = Identifier.ascending("message")
        await writeMessage(session.id, keepID, "keep needle", Date.now())
        await writeMessage(session.id, dropID, "drop needle", Date.now())

        const scopeID = scopeIDOf(session)
        const sessionID = Identifier.asSessionID(session.id)

        // removePart marks dirty.
        const parts = await MessageV2.parts({ scopeID, sessionID, messageID: keepID })
        const textPart0 = parts.find((p) => p.type === "text")!
        await Session.removePart({ sessionID: session.id, messageID: keepID, partID: textPart0.id })
        expect(await SessionSearchIndex.isDirty(scopeID, sessionID)).toBe(true)

        // removeMessage marks dirty.
        await Session.removeMessage({ sessionID: session.id, messageID: dropID })
        expect(await SessionSearchIndex.isDirty(scopeID, sessionID)).toBe(true)

        // Session.remove removes index and dirty marker entirely.
        await SessionSearchIndex.rebuildSession(scopeID, sessionID)
        expect(await SessionSearchIndex.isDirty(scopeID, sessionID)).toBe(false)
        await Session.remove(session.id)
        expect(await SessionSearchIndex.readRecord(scopeID, sessionID)).toBeUndefined()
        expect(await SessionSearchIndex.isDirty(scopeID, sessionID)).toBe(false)
      },
    })
  })

  test("tool query scans once (write-through) then serves clean sessions from the index", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Indexed Path" })
        await writeMessage(session.id, Identifier.ascending("message"), "p2IndexNeedle token", Date.now())

        const tool = await SessionSearchTool.init()

        // First query: no record yet -> scan + write-through rebuild.
        const first = await run(tool, "p2IndexNeedle")
        expect(first.metadata.matches).toBeGreaterThanOrEqual(1)
        expect(first.metadata.scanned).toBeGreaterThanOrEqual(1)
        expect(first.metadata.freshness).toBe("possibly_stale")

        // Second query: clean record -> indexed fast path, no message scan.
        const second = await run(tool, "p2IndexNeedle")
        expect(second.metadata.matches).toBeGreaterThanOrEqual(1)
        expect(second.metadata.indexed).toBeGreaterThanOrEqual(1)
        expect(second.metadata.scanned).toBe(0)
        expect(second.metadata.freshness).toBe("fresh")
      },
    })
  })

  test("tool query after a write still finds the new content (dirty fallback) and cleans up", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Dirty Fallback" })
        await writeMessage(session.id, Identifier.ascending("message"), "before needle", Date.now())

        const tool = await SessionSearchTool.init()
        await run(tool, "before")

        // New content after the index is clean -> dirty marker forces rescan.
        await writeMessage(session.id, Identifier.ascending("message"), "afterNeedle unique token", Date.now())
        const result = await run(tool, "afterNeedle")
        expect(result.metadata.matches).toBeGreaterThanOrEqual(1)
        expect(result.metadata.scanned).toBeGreaterThanOrEqual(1)

        // The rescan rebuilt the record: a third query is served from the index.
        const third = await run(tool, "afterNeedle")
        expect(third.metadata.indexed).toBeGreaterThanOrEqual(1)
        expect(third.metadata.scanned).toBe(0)
      },
    })
  })

  test("clean multi-session query is served per-session (indexed) with zero message scans", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // 6 sessions x 4 messages each, all indexed by a first query.
        for (let s = 0; s < 6; s++) {
          const session = await Session.create({ title: `Perf ${s}` })
          for (let m = 0; m < 4; m++) {
            await writeMessage(
              session.id,
              Identifier.ascending("message"),
              m === 2 ? `perfNeedle session${s} msg${m}` : `padding message ${s}.${m}`,
              Date.now() + s * 1000 + m,
            )
          }
        }

        const tool = await SessionSearchTool.init()
        // Warm the index (each session scanned once).
        const warm = await run(tool, "perfNeedle", { scope: "current", limit: 100 })
        expect(warm.metadata.scanned).toBe(6)
        expect(warm.metadata.indexed).toBe(0)

        // Clean query: every session served from its index record — zero scans,
        // matches found across all 6 sessions without streaming their messages.
        const clean = await run(tool, "perfNeedle", { scope: "current", limit: 100 })
        expect(clean.metadata.scanned).toBe(0)
        expect(clean.metadata.indexed).toBe(6)
        expect(clean.metadata.matches).toBe(6)
        expect(clean.metadata.freshness).toBe("fresh")
      },
    })
  })
  test("a stale-version record is treated as missing and rebuilt on the next query", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Version Stale" })
        await writeMessage(session.id, Identifier.ascending("message"), "versionNeedle content", Date.now())

        const scopeID = scopeIDOf(session)
        const sessionID = Identifier.asSessionID(session.id)

        // Build a clean v2 record, then overwrite it with a v1 record whose
        // content no longer reflects the message (simulating a pre-upgrade
        // cache from an older format).
        await SessionSearchIndex.rebuildSession(scopeID, sessionID)
        expect(await SessionSearchIndex.isDirty(scopeID, sessionID)).toBe(false)

        const { Storage } = await import("../../src/storage/storage")
        const { StoragePath } = await import("../../src/storage/path")
        await Storage.write(
          StoragePath.sessionSearchIndex(scopeID, sessionID),
          {
            version: 1,
            tokenizerVersion: 1,
            scopeID,
            sessionID,
            updatedAt: Date.now(),
            messages: [],
          },
          { compact: true },
        )

        // readRecord ignores the stale version, so the query rescans and finds
        // the content, then persists a current-version record.
        const tool = await SessionSearchTool.init()
        const result = await run(tool, "versionNeedle")
        expect(result.metadata.matches).toBeGreaterThanOrEqual(1)
        expect(result.metadata.scanned).toBeGreaterThanOrEqual(1)

        const record = await SessionSearchIndex.readRecord(scopeID, sessionID)
        expect(record?.version).toBe(SessionSearchIndex.VERSION)
        expect(record?.messages[0]?.text).toContain("versionNeedle")
      },
    })
  })

  test("oversized data URLs are bounded to a size marker instead of copied into the record", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Data URL Cap" })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage(userMessage(session.id, messageID, Date.now()))
        const payload = "x".repeat(100_000)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "attachment",
          mime: "application/pdf",
          filename: "bigdata-unique-3f1a.pdf",
          url: `data:application/pdf;base64,${payload}`,
          // provider-file attachments keep their data: URL inline (instead of
          // externalizing to asset://), which is exactly when the indexer must
          // bound the payload.
          model: { mode: "provider-file" },
        } as MessageV2.Part)

        const scopeID = scopeIDOf(session)
        const record = await SessionSearchIndex.rebuildSession(scopeID, Identifier.asSessionID(session.id))
        const attachment = record.messages[0]!.attachment!

        // The filename stays searchable, the raw payload does not enter the
        // cache, and a bounded size marker makes the omission observable.
        expect(attachment).toContain("bigdata-unique-3f1a.pdf")
        expect(attachment).not.toContain(payload)
        expect(attachment).toMatch(/\(\d+-byte inline payload\)/)
      },
    })
  })

  test("attachments nested in completed tool state join the attachment index", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Nested Tool Attachment" })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage(userMessage(session.id, messageID, Date.now()))
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
            output: "done",
            title: "T",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
            attachments: [
              {
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID,
                type: "attachment",
                mime: "image/png",
                filename: "nestedtool-unique-8b2e.png",
                url: "file:///nestedtool-unique-8b2e.png",
              } satisfies MessageV2.AttachmentPart,
            ],
          },
        } as MessageV2.Part)

        const scopeID = scopeIDOf(session)
        const record = await SessionSearchIndex.rebuildSession(scopeID, Identifier.asSessionID(session.id))
        expect(record.messages[0]!.attachment).toContain("nestedtool-unique-8b2e.png")
      },
    })
  })
})
