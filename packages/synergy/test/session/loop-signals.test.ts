import { describe, expect, test, beforeAll } from "bun:test"
import { SessionCompaction } from "../../src/session/compaction"
import { LoopJob } from "../../src/session/loop-job"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// ─── helpers ───────────────────────────────────────────────────────

// The LoopJob.Context uses two shapes:
// - ctx.messages: array of WithParts (flat user msg or wrapped assistant msg)
//   → code accesses m.info.role (via type guard m.info.role === "assistant")
// - ctx.lastUser: flat user object (the last user message in the session)
//   → code accesses ctx.lastUser.role (for permission/session metadata)
// - ctx.lastUserParts: array of Part (parts of the last user message)
//   → code accesses ctx.lastUserParts.some(p => p.type === "compaction")
//
// makeUser() returns the flat user shape for ctx.lastUser.
// makeUserWrapper() returns the WithParts shape for ctx.messages.

function makeUser(): any {
  return {
    id: "usr_test",
    role: "user" as const,
    sessionID: "ses_test",
    time: { created: Date.now() },
    agent: "synergy",
    model: { providerID: "test-provider", modelID: "test-model" },
  }
}

function makeUserWrapper(): any {
  return { info: makeUser(), parts: [] }
}

function makeAssistant(toolParts: any[]): any {
  return {
    info: {
      id: `msg_${Math.random().toString(36).slice(2)}`,
      role: "assistant" as const,
      sessionID: "ses_test",
      agent: "synergy",
      mode: "synergy",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model",
      providerID: "test-provider",
      time: { created: Date.now() },
    },
    parts: toolParts,
  }
}

function makeSummary(parentID = "usr_test", requestID?: string): any {
  return {
    info: {
      id: `msg_summary_${Math.random().toString(36).slice(2)}`,
      role: "assistant" as const,
      sessionID: "ses_test",
      parentID,
      agent: "compaction",
      mode: "compaction",
      summary: true,
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model",
      providerID: "test-provider",
      time: { created: Date.now(), completed: Date.now() },
      ...(requestID ? { metadata: { compactionRequestPartID: requestID } } : {}),
    },
    parts: [],
  }
}

function makeTool(tool: string, input: unknown, status: "completed" | "error"): any {
  return {
    id: `prt_${Math.random().toString(36).slice(2)}`,
    messageID: "msg_test",
    sessionID: "ses_test",
    type: "tool",
    tool,
    callID: `call_${Math.random().toString(36).slice(2)}`,
    state:
      status === "completed"
        ? { status, input, output: "done", title: "ok" }
        : { status, input, error: "SomeError: test" },
  }
}

function makeTextPart(text: string): any {
  return {
    id: `prt_${Math.random().toString(36).slice(2)}`,
    messageID: "msg_test",
    sessionID: "ses_test",
    type: "text",
    text,
  }
}

function makeCtx(step: number, messages: any[], lastUserParts: any[] = []): any {
  return {
    session: { id: "ses_test" },
    sessionID: "ses_test",
    step,
    messages,
    lastUser: makeUser(),
    lastUserParts,
    abort: new AbortController().signal,
    modelLimits: { context: 200_000, output: 8_192 },
  }
}

// ─── import signals (registers them into LoopJob) ──────────────────

beforeAll(async () => {
  await import("../../src/session/loop-signals")
})

// ─── tests ─────────────────────────────────────────────────────────

describe("loop-signals: repeat_loop signal", () => {
  test("fires when the same tool+params succeeds 3 times in a row", async () => {
    const ctx = makeCtx(3, [
      makeUserWrapper(),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
    ])
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("repeat_loop")
  })

  test("does not fire below threshold", async () => {
    const ctx = makeCtx(2, [
      makeUserWrapper(),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
    ])
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("repeat_loop")
  })

  test("does not fire when params differ", async () => {
    const ctx = makeCtx(3, [
      makeUserWrapper(),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      makeAssistant([makeTool("Read", { path: "/b" }, "completed")]),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
    ])
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("repeat_loop")
  })

  test("does not fire when tool differs", async () => {
    const ctx = makeCtx(3, [
      makeUserWrapper(),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      makeAssistant([makeTool("Grep", { path: "/a" }, "completed")]),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
    ])
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("repeat_loop")
  })

  test("does not fire when a call failed in the sequence", async () => {
    const ctx = makeCtx(3, [
      makeUserWrapper(),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      makeAssistant([makeTool("Read", { path: "/a" }, "error")]),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
    ])
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("repeat_loop")
  })

  test("does not fire when assistant message has no tool parts", async () => {
    const ctx = makeCtx(3, [
      makeUserWrapper(),
      makeAssistant([]),
      makeAssistant([makeTextPart("hello")]),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
    ])
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("repeat_loop")
  })

  test("does not fire when fewer than 3 messages have tool parts", async () => {
    const ctx = makeCtx(3, [
      makeUserWrapper(),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
    ])
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("repeat_loop")
  })
})

describe("loop-signals: repeat_loop_injector job", () => {
  test("is collected when repeat_loop signal fires", async () => {
    const ctx = makeCtx(3, [
      makeUserWrapper(),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
    ])

    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("repeat_loop")

    const instances = LoopJob.collect("pre", ctx, fired)
    const repeatJob = instances.find((i: any) => i.type === "repeat_loop_injector")
    expect(repeatJob).toBeDefined()
    expect(repeatJob!.type).toBe("repeat_loop_injector")
  })
})

describe("loop-signals: compact signal", () => {
  test("detects when compaction part exists", async () => {
    const ctx = makeCtx(
      1,
      [makeUserWrapper()],
      [{ id: "p1", sessionID: "ses_test", messageID: "m1", type: "compaction", auto: false }],
    )
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("compact")
  })

  test("does not detect when no compaction part", async () => {
    const ctx = makeCtx(
      1,
      [makeUserWrapper()],
      [{ id: "p1", sessionID: "ses_test", messageID: "m1", type: "text", text: "hello" }],
    )
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("compact")
  })

  test("does not detect when the latest compaction request is fulfilled", async () => {
    const ctx = makeCtx(
      1,
      [makeUserWrapper(), makeSummary("usr_test", "p1")],
      [{ id: "p1", sessionID: "ses_test", messageID: "m1", type: "compaction", auto: true }],
    )
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("compact")
  })

  test("detects a new compaction request after an older completed summary", async () => {
    const ctx = makeCtx(
      2,
      [makeUserWrapper(), makeSummary("usr_test", "p1")],
      [
        { id: "p1", sessionID: "ses_test", messageID: "m1", type: "compaction", auto: true },
        { id: "p2", sessionID: "ses_test", messageID: "m1", type: "compaction", auto: true },
      ],
    )
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("compact")
  })

  test("detects a new compaction request after a legacy completed summary", async () => {
    const ctx = makeCtx(
      2,
      [makeUserWrapper(), makeSummary("usr_test")],
      [
        { id: "p1", sessionID: "ses_test", messageID: "m1", type: "compaction", auto: true },
        { id: "p2", sessionID: "ses_test", messageID: "m1", type: "compaction", auto: true },
      ],
    )
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("compact")
  })

  test("uses full compaction history when compacted prompt history only keeps the latest summary", async () => {
    const root = makeUserWrapper()
    root.parts = [
      { id: "p1", sessionID: "ses_test", messageID: "usr_test", type: "compaction", auto: true },
      { id: "p2", sessionID: "ses_test", messageID: "usr_test", type: "compaction", auto: true },
    ]
    const firstSummary = makeSummary("usr_test", "p1")
    const secondSummary = makeSummary("usr_test", "p2")
    const ctx = makeCtx(3, [root, secondSummary], root.parts)
    ctx.compactionHistory = SessionCompaction.completedCompactionHistory([firstSummary, secondSummary], root.info.id)

    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("compact")
  })

  test("still detects a genuinely new request after completed compaction history", async () => {
    const root = makeUserWrapper()
    root.parts = [
      { id: "p1", sessionID: "ses_test", messageID: "usr_test", type: "compaction", auto: true },
      { id: "p2", sessionID: "ses_test", messageID: "usr_test", type: "compaction", auto: true },
      { id: "p3", sessionID: "ses_test", messageID: "usr_test", type: "compaction", auto: true },
    ]
    const firstSummary = makeSummary("usr_test", "p1")
    const secondSummary = makeSummary("usr_test", "p2")
    const ctx = makeCtx(3, [root, secondSummary], root.parts)
    ctx.compactionHistory = SessionCompaction.completedCompactionHistory([firstSummary, secondSummary], root.info.id)

    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("compact")
  })

  test("coexists with repeat_loop without interference", async () => {
    const ctx = makeCtx(
      5,
      [
        makeUserWrapper(),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      ],
      [{ id: "p1", sessionID: "ses_test", messageID: "m1", type: "compaction", auto: true }],
    )
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("compact")
    expect(fired).toContain("repeat_loop")
    expect(fired).not.toContain("error_loop")
  })
})
