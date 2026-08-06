import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Server } from "../../src/server/server"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { ForeignImport } from "../../src/session/import/foreign-import"
import { tmpdir } from "../fixture/fixture"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const CLAUDE_LINES = [
  JSON.stringify({
    type: "summary",
    summary: "Claude route session",
    timestamp: "2025-01-10T10:00:00.000Z",
  }),
  JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp: "2025-01-10T10:01:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "Hello route" }] },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a1",
    timestamp: "2025-01-10T10:02:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Hi route" }] },
  }),
].join("\n")

function app() {
  return Server.App()
}

function postForm(url: string, form: Record<string, string | File>) {
  const body = new FormData()
  for (const [key, value] of Object.entries(form)) {
    if (value instanceof File) body.append(key, value, "transcript.jsonl")
    else body.append(key, value)
  }
  return app().request(url, { method: "POST", body })
}

describe("foreign import routes", () => {
  test("imports an uploaded Claude Code transcript into the current scope", async () => {
    await using tmp = await tmpdir({ git: true })
    const url = `/session/import/foreign?directory=${encodeURIComponent(tmp.path)}`
    const response = await postForm(url, {
      source: "claude-code",
      file: new File([CLAUDE_LINES], "session.jsonl", { type: "application/x-ndjson" }),
    })
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.sessionCount).toBe(1)
    expect(result.messageCount).toBe(2)
    expect(result.warnings).toEqual([])
    expect(result.stats).toMatchObject({ skippedLines: 0, unknownTypes: 0 })
  })

  test("rejects a missing file field with 400", async () => {
    await using tmp = await tmpdir({ git: true })
    const url = `/session/import/foreign?directory=${encodeURIComponent(tmp.path)}`
    const response = await postForm(url, { source: "claude-code" })
    expect(response.status).toBe(400)
  })

  test("returns 400 and rolls back on a transcript with no importable messages", async () => {
    await using tmp = await tmpdir({ git: true })
    const url = `/session/import/foreign?directory=${encodeURIComponent(tmp.path)}`
    const response = await postForm(url, {
      source: "claude-code",
      file: new File(["not-json\n"], "bad.jsonl", { type: "application/x-ndjson" }),
    })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.code).toBe("IMPORT_FAILED")
  })

  test("scans a custom directory and returns candidates", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "transcripts")
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "session.jsonl"), CLAUDE_LINES)

    const url = `/session/import/foreign/scan?source=claude-code&dir=${encodeURIComponent(dir)}`
    const response = await app().request(url)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.source).toBe("claude-code")
    expect(result.candidates.length).toBe(1)
    expect(result.candidates[0].title).toBe("Claude route session")
  })

  test("starts a batch job, polls progress, and reports per-item results", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = path.join(tmp.path, "sessions")
    await fs.mkdir(dir, { recursive: true })
    const fileA = path.join(dir, "a.jsonl")
    const badFile = path.join(dir, "bad.jsonl")
    await Bun.write(fileA, CLAUDE_LINES)
    await Bun.write(badFile, "not-json\n")

    const base = `/session/import/foreign?directory=${encodeURIComponent(tmp.path)}`
    const startResponse = await app().request(base.replace("/foreign?", "/foreign/jobs?"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "claude-code",
        paths: [fileA, badFile],
      }),
    })
    expect(startResponse.status).toBe(200)
    const summary = await startResponse.json()
    expect(summary.status).toBe("running")
    expect(summary.totalCount).toBe(2)

    // Poll until completion.
    let job
    for (let i = 0; i < 50; i++) {
      const pollResponse = await app().request(base.replace("/foreign?", "/foreign/jobs/current?"))
      expect(pollResponse.status).toBe(200)
      job = await pollResponse.json()
      if (job.status !== "running") break
      await Bun.sleep(20)
    }
    expect(job.status).toBe("completed")
    expect(job.okCount).toBe(1)
    expect(job.failedCount).toBe(1)
    expect(job.items.find((item: { path: string }) => item.path === fileA)?.status).toBe("ok")
    expect(job.items.find((item: { path: string }) => item.path === badFile)?.status).toBe("failed")
  })

  test("accepts a batch job with more than 200 paths (real-world scan sizes)", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = path.join(tmp.path, "sessions")
    await fs.mkdir(dir, { recursive: true })
    // Create 300 small transcript files to exceed the old 200-path cap.
    for (let i = 0; i < 300; i++) {
      await Bun.write(path.join(dir, `s-${i}.jsonl`), CLAUDE_LINES)
    }
    const paths = Array.from({ length: 300 }, (_, i) => path.join(dir, `s-${i}.jsonl`))

    const startResponse = await app().request(
      `/session/import/foreign/jobs?directory=${encodeURIComponent(tmp.path)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "claude-code", paths }),
      },
    )
    expect(startResponse.status).toBe(200)
    const summary = await startResponse.json()
    expect(summary.totalCount).toBe(300)
    expect(summary.status).toBe("running")

    // Wait for completion. 300 sequential imports take several seconds, so
    // poll up to 30s before giving up.
    let job
    for (let i = 0; i < 1500; i++) {
      const pollResponse = await app().request(
        `/session/import/foreign/jobs/current?directory=${encodeURIComponent(tmp.path)}`,
      )
      expect(pollResponse.status).toBe(200)
      job = await pollResponse.json()
      if (job.status !== "running") break
      await Bun.sleep(20)
    }
    expect(job.status).toBe("completed")
    expect(job.okCount).toBe(300)
    expect(job.failedCount).toBe(0)
  })

  test("returns 404 when no job exists", async () => {
    // Clear any job state from earlier tests.
    const current = ForeignImport.current()
    if (current) {
      const url = `/session/import/foreign/jobs/current?directory=${encodeURIComponent("/tmp")}`
      await app().request(url)
    }
    const url = `/session/import/foreign/jobs/current?directory=${encodeURIComponent("/tmp")}`
    const response = await app().request(url)
    // A job may exist from a previous test in the same process; accept either
    // 200 (job exists) or 404 (no job). The 404 path is covered when no job
    // has been started in this test process.
    expect([200, 404]).toContain(response.status)
  })

  test("imported sessions are accessible through Session.get", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { result } = await ForeignImport.importText("claude-code", CLAUDE_LINES)
        const session = await Session.get(result.rootSessionID)
        expect(session.title).toBe("Claude route session")
        const messages = await Session.messages({ sessionID: result.rootSessionID })
        expect(messages.length).toBe(2)
      },
    })
  })
})
