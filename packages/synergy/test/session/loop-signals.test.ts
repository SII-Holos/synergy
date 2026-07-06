import { describe, expect, test, beforeAll } from "bun:test"
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

function makeUser(agent = "synergy"): any {
  return {
    id: "usr_test",
    role: "user" as const,
    sessionID: "ses_test",
    time: { created: Date.now() },
    agent,
    model: { providerID: "test-provider", modelID: "test-model" },
  }
}

function makeUserWrapper(agent = "synergy"): any {
  return { info: makeUser(agent), parts: [] }
}

function makeAssistant(toolParts: any[], agent = "synergy"): any {
  return {
    info: {
      id: `msg_${Math.random().toString(36).slice(2)}`,
      role: "assistant" as const,
      sessionID: "ses_test",
      agent,
      mode: agent,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model",
      providerID: "test-provider",
      time: { created: Date.now() },
    },
    parts: toolParts,
  }
}

function makeTool(
  tool: string,
  input: unknown,
  status: "completed" | "error",
  options: { output?: string; error?: string; metadata?: Record<string, any> } = {},
): any {
  return {
    id: `prt_${Math.random().toString(36).slice(2)}`,
    messageID: "msg_test",
    sessionID: "ses_test",
    type: "tool",
    tool,
    callID: `call_${Math.random().toString(36).slice(2)}`,
    state:
      status === "completed"
        ? { status, input, output: options.output ?? "done", title: "ok", metadata: options.metadata ?? {} }
        : { status, input, error: options.error ?? "SomeError: test" },
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

function makeCtx(step: number, messages: any[], lastUserParts: any[] = [], agent = "synergy"): any {
  return {
    session: { id: "ses_test" },
    sessionID: "ses_test",
    step,
    messages,
    lastUser: makeUser(agent),
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

describe("loop-signals: tool_failure_pattern (scholar search)", () => {
  test("fires after consecutive no-result scholar searches", async () => {
    const ctx = makeCtx(
      2,
      [
        makeUserWrapper("scholar"),
        makeAssistant(
          [
            makeTool("websearch", { query: "very specific paper xyz" }, "completed", {
              output: "No search results found. Please try a different query.",
              metadata: { searchFailureType: "no_results" },
            }),
          ],
          "scholar",
        ),
        makeAssistant(
          [
            makeTool("arxiv_search", { query: "very specific paper xyz", startDate: "2026-01-01" }, "completed", {
              output: "No papers found matching your search criteria.",
              metadata: { searchFailureType: "no_results" },
            }),
          ],
          "scholar",
        ),
      ],
      [],
      "scholar",
    )

    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("tool_failure_pattern")
  })

  test("does not fire for non-scholar agents", async () => {
    const ctx = makeCtx(2, [
      makeUserWrapper(),
      makeAssistant([
        makeTool("websearch", { query: "missing one" }, "completed", {
          output: "No search results found. Please try a different query.",
          metadata: { searchFailureType: "no_results" },
        }),
      ]),
      makeAssistant([
        makeTool("websearch", { query: "missing two" }, "completed", {
          output: "No search results found. Please try a different query.",
          metadata: { searchFailureType: "no_results" },
        }),
      ]),
    ])

    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("tool_failure_pattern")
  })

  test("fires early stop after reflection and continued failures", async () => {
    // The early-stop check is independent: it only checks the earlyStopMarker,
    // not the reflectionMarker. So having the reflection marker present won't block it.
    const reflectionMarker = makeTextPart("[Search failure reflection]\nPrevious search failed.")
    reflectionMarker.synthetic = true

    const ctx = makeCtx(
      4,
      [
        makeUserWrapper("scholar"),
        makeAssistant(
          [
            makeTool("websearch", { query: "a" }, "completed", {
              output: "No search results found. Please try a different query.",
              metadata: { searchFailureType: "no_results" },
            }),
          ],
          "scholar",
        ),
        makeAssistant(
          [
            makeTool("webfetch", { url: "https://example.com/a" }, "error", {
              error: "Request failed with status code: 403",
            }),
          ],
          "scholar",
        ),
        makeAssistant(
          [
            makeTool("webfetch", { url: "https://example.com/b" }, "error", {
              error: "Request failed with status code: 404",
            }),
          ],
          "scholar",
        ),
        makeAssistant(
          [
            makeTool("arxiv_search", { query: "b" }, "completed", {
              output: "No papers found matching your search criteria.",
              metadata: { searchFailureType: "no_results" },
            }),
          ],
          "scholar",
        ),
      ],
      [reflectionMarker],
      "scholar",
    )

    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("tool_failure_pattern")
  })
})
