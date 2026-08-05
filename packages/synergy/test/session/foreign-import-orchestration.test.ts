import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionImport } from "../../src/session/session-import"
import { ForeignImport } from "../../src/session/import/foreign-import"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const CLAUDE_LINES = [
  JSON.stringify({
    type: "summary",
    summary: "Claude session A",
    timestamp: "2025-01-10T10:00:00.000Z",
  }),
  JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp: "2025-01-10T10:01:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "Hello from claude" }] },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a1",
    timestamp: "2025-01-10T10:02:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Hi from claude" }] },
  }),
].join("\n")

const CODEX_LINES = [
  JSON.stringify({
    type: "session_meta",
    timestamp: "2025-02-01T10:00:00.000Z",
    payload: { id: "rollout-1", cwd: "/repo", source: "codex" },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2025-02-01T10:01:00.000Z",
    payload: { type: "user_message", message: "Hello from codex" },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "2025-02-01T10:02:00.000Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi from codex" }] },
  }),
].join("\n")

describe("ForeignImport", () => {
  test("importText imports a Claude Code transcript and creates a session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { result, stats } = await ForeignImport.importText("claude-code", CLAUDE_LINES)
        expect(result.sessionCount).toBe(1)
        expect(result.messageCount).toBe(2)
        expect(stats.skippedLines).toBe(0)

        const session = await Session.get(result.rootSessionID)
        expect(session.title).toBe("Claude session A")
        expect((session.scope as { id: string }).id).toBe((ScopeContext.current.scope as { id: string }).id)
      },
    })
  })

  test("importText imports a Codex transcript and creates a session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { result } = await ForeignImport.importText("codex", CODEX_LINES)
        expect(result.sessionCount).toBe(1)
        expect(result.messageCount).toBe(2)
        const session = await Session.get(result.rootSessionID)
        expect(session.title).toBe("codex")
      },
    })
  })

  test("imports into the scope that owns the transcript working directory", async () => {
    await using project = await tmpdir({ git: true })
    await using current = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await current.scope(),
      fn: async () => {
        const { result } = await ForeignImport.importText("claude-code", CLAUDE_LINES, { cwd: project.path })
        const session = await Session.get(result.rootSessionID)
        const sessionScope = session.scope as { id: string }
        const projectScope = await project.scope()
        expect(sessionScope.id).toBe(projectScope.id)
        expect(sessionScope.id).not.toBe((ScopeContext.current.scope as { id: string }).id)
      },
    })
  })

  test("falls back to the current scope when the working directory is missing", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { result } = await ForeignImport.importText("codex", CODEX_LINES, {
          cwd: "/nonexistent/path-for-import-test",
        })
        const session = await Session.get(result.rootSessionID)
        expect((session.scope as { id: string }).id).toBe((ScopeContext.current.scope as { id: string }).id)
      },
    })
  })

  test("claudeCodeCwdFromFile decodes the encoded project directory", () => {
    expect(ForeignImport.claudeCodeCwdFromFile("/Users/x/.claude/projects/-Users-me-project/abc.jsonl")).toBe(
      "/Users/me/project",
    )
    expect(ForeignImport.claudeCodeCwdFromFile("/tmp/custom/session.jsonl")).toBeUndefined()
  })

  test("rejects transcripts with no importable messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(ForeignImport.importText("claude-code", "not-json\n")).rejects.toThrow(/No importable messages/)
        const sessions = []
        for await (const session of Session.listAll()) sessions.push(session)
        expect(sessions.length).toBe(0)
      },
    })
  })

  test("rolls back all created sessions when the write path fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // Build a two-session report: the first session writes fine, the
        // second carries an invalid tool part so Session.updatePart's schema
        // validation throws mid-import. The first session must be rolled back.
        const { report } = await ForeignImport.parseTranscript("claude-code", CLAUDE_LINES)
        const first = report.sessions[0]
        const second = structuredClone(first)
        second.info.id = "ses_second"
        second.messages[0].info.sessionID = "ses_second"
        second.messages[0].info.id = "msg_second"
        second.messages[0].parts = [
          // Invalid tool part: missing `state` — fails MessageV2.Part parse.
          { id: "prt_bad", sessionID: "ses_second", messageID: "msg_second", type: "tool", callID: "c", tool: "x" },
        ] as any
        report.sessions = [first, second]

        let createdCount = 0
        await expect(
          SessionImport.fromReport(report, {
            onSessionCreated: () => createdCount++,
          }),
        ).rejects.toThrow()
        expect(createdCount).toBeGreaterThan(0)

        // The bare fromReport call above has no rollback; clean up the
        // sessions it left behind so they do not pollute the assertion below.
        const dirty = []
        for await (const session of Session.listAll()) dirty.push(session)
        for (const item of dirty) await Session.remove(item.id)

        // importText must roll back its own created sessions so the scope has
        // no leftover sessions from the failed attempt.
        await expect(ForeignImport.importText("claude-code", JSON.stringify(report))).rejects.toThrow()
        const sessions = []
        for await (const session of Session.listAll()) sessions.push(session)
        expect(sessions.length).toBe(0)
      },
    })
  })

  test("scanCandidates lists transcript files under a custom directory", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "transcripts")
    await fs.mkdir(path.join(root, "nested"), { recursive: true })
    await Bun.write(path.join(root, "session-1.jsonl"), CLAUDE_LINES)
    await Bun.write(path.join(root, "nested", "session-2.jsonl"), CLAUDE_LINES)
    await Bun.write(path.join(root, "notes.txt"), "not a transcript")
    await Bun.write(path.join(root, "agent-sidechain.jsonl"), CLAUDE_LINES)

    const candidates = await ForeignImport.scanCandidates("claude-code", root)
    expect(candidates.length).toBe(2) // agent-* sidechain files excluded
    expect(candidates.every((c) => c.path.endsWith(".jsonl"))).toBe(true)
    expect(candidates.some((c) => c.path.includes("session-1"))).toBe(true)
    expect(candidates.some((c) => c.path.includes("session-2"))).toBe(true)
  })

  test("scanCandidates returns empty for a missing directory", async () => {
    await using tmp = await tmpdir()
    const candidates = await ForeignImport.scanCandidates("claude-code", path.join(tmp.path, "missing"))
    expect(candidates).toEqual([])
  })

  test("importFile reads and imports a transcript file", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "session.jsonl")
    await Bun.write(file, CLAUDE_LINES)

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { result } = await ForeignImport.importFile(file, { source: "claude-code" })
        expect(result.sessionCount).toBe(1)
      },
    })
  })

  test("batch job imports multiple files and reports per-item results", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = path.join(tmp.path, "sessions")
    await fs.mkdir(dir, { recursive: true })
    const fileA = path.join(dir, "a.jsonl")
    const badFile = path.join(dir, "bad.jsonl")
    await Bun.write(fileA, CLAUDE_LINES)
    await Bun.write(badFile, "not-json\n")

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const summary = ForeignImport.start({
          source: "claude-code",
          paths: [fileA, badFile],
        })
        expect(summary.status).toBe("running")
        expect(summary.totalCount).toBe(2)

        // Wait for the job to complete.
        while (ForeignImport.currentSummary()?.status === "running") {
          await Bun.sleep(20)
        }

        const done = ForeignImport.currentSummary()!
        expect(done.status).toBe("completed")
        expect(done.completedCount).toBe(2)
        expect(done.okCount).toBe(1)
        expect(done.failedCount).toBe(1)

        const job = ForeignImport.getJob(done.id)!
        expect(job.items.find((item) => item.path === fileA)?.status).toBe("ok")
        expect(job.items.find((item) => item.path === badFile)?.status).toBe("failed")
      },
    })
  })

  test("empty batch job completes immediately", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const summary = ForeignImport.start({
          source: "claude-code",
          paths: [],
        })
        expect(summary.status).toBe("completed")
      },
    })
  })

  test("defaultRoot honors environment overrides", () => {
    const originalClaude = process.env.CLAUDE_CONFIG_DIR
    const originalCodex = process.env.CODEX_HOME
    try {
      process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-config"
      process.env.CODEX_HOME = "/tmp/codex-home"
      expect(ForeignImport.defaultRoot("claude-code")).toBe("/tmp/claude-config/projects")
      expect(ForeignImport.defaultRoot("codex")).toBe("/tmp/codex-home/sessions")
    } finally {
      if (originalClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = originalClaude
      if (originalCodex === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodex
    }
  })
})
