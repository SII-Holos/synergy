import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
import { describe, expect, test, beforeAll } from "bun:test"
import { LoopJob } from "../../src/session/loop-job"
import { Log } from "../../src/util/log"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { MessageV2 } from "../../src/session/message-v2"
const runtime = await testRuntime()

runtime.run(() => Log.init({ print: false }))

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

function makeUser(agent: string = PrimaryAgentIdentity.names.general): any {
  return {
    id: "usr_test",
    role: "user" as const,
    sessionID: "ses_test",
    time: { created: Date.now() },
    agent,
    model: { providerID: "test-provider", modelID: "test-model" },
  }
}

function makeUserWrapper(agent: string = PrimaryAgentIdentity.names.general): any {
  return { info: makeUser(agent), parts: [] }
}

function makeAssistant(toolParts: any[], agent: string = PrimaryAgentIdentity.names.general): any {
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

async function makeCtx(
  step: number,
  messages: any[],
  lastUserParts: any[] = [],
  agent: string = PrimaryAgentIdentity.names.general,
): Promise<LoopJob.Context> {
  return ScopeContext.provide({
    scope: Scope.home(),
    fn: async () => {
      const session = await Session.create({ workspace: null })
      const rootID = Identifier.ascending("message")
      let lastUser: MessageV2.User | undefined
      const created = Date.now()
      for (const [index, message] of messages.entries()) {
        const id = index === 0 ? rootID : Identifier.ascending("message")
        const info =
          message.info.role === "user"
            ? { ...message.info, id, sessionID: session.id, isRoot: true, time: { created: created + index } }
            : {
                ...message.info,
                id,
                sessionID: session.id,
                rootID,
                parentID: rootID,
                path: { cwd: null, root: null },
                time: { created: created + index },
              }
        await Session.updateMessage(info)
        if (info.role === "user") lastUser = { ...info, agent }
        const parts = info.role === "user" ? lastUserParts : message.parts
        for (const part of parts)
          await Session.updatePart({
            ...part,
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: id,
            ...(part.type === "tool"
              ? { state: { ...part.state, time: { start: created + index, end: created + index } } }
              : {}),
          })
      }
      if (!lastUser) throw new Error("Loop fixture requires a user root")
      return {
        session,
        sessionID: session.id,
        step,
        messages: await Session.messages({ sessionID: session.id }),
        lastUser,
        lastUserParts: await MessageV2.parts({ sessionID: session.id, messageID: lastUser.id }),
        abort: new AbortController().signal,
        modelLimits: { context: 200_000, output: 8_192 },
      }
    },
  })
}

// ─── import signals (registers them into LoopJob) ──────────────────

beforeAll(() =>
  runtime.run(async () => {
    await import("../../src/session/loop-signals")
  }),
)

// ─── tests ─────────────────────────────────────────────────────────

describe("loop-signals: repeat_loop signal", () => {
  test("fires when the same tool+params succeeds 3 times in a row", () =>
    runtime.run(async () => {
      const ctx = await makeCtx(3, [
        makeUserWrapper(),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      ])
      const fired = await LoopJob.detectSignals(ctx)
      expect(fired).toContain("repeat_loop")
    }))

  test("does not fire below threshold", () =>
    runtime.run(async () => {
      const ctx = await makeCtx(2, [
        makeUserWrapper(),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      ])
      const fired = await LoopJob.detectSignals(ctx)
      expect(fired).not.toContain("repeat_loop")
    }))

  test("does not fire when params differ", () =>
    runtime.run(async () => {
      const ctx = await makeCtx(3, [
        makeUserWrapper(),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
        makeAssistant([makeTool("Read", { path: "/b" }, "completed")]),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      ])
      const fired = await LoopJob.detectSignals(ctx)
      expect(fired).not.toContain("repeat_loop")
    }))

  test("does not fire when tool differs", () =>
    runtime.run(async () => {
      const ctx = await makeCtx(3, [
        makeUserWrapper(),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
        makeAssistant([makeTool("Grep", { path: "/a" }, "completed")]),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      ])
      const fired = await LoopJob.detectSignals(ctx)
      expect(fired).not.toContain("repeat_loop")
    }))

  test("does not fire when a call failed in the sequence", () =>
    runtime.run(async () => {
      const ctx = await makeCtx(3, [
        makeUserWrapper(),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
        makeAssistant([makeTool("Read", { path: "/a" }, "error")]),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      ])
      const fired = await LoopJob.detectSignals(ctx)
      expect(fired).not.toContain("repeat_loop")
    }))

  test("does not fire when assistant message has no tool parts", () =>
    runtime.run(async () => {
      const ctx = await makeCtx(3, [
        makeUserWrapper(),
        makeAssistant([]),
        makeAssistant([makeTextPart("hello")]),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      ])
      const fired = await LoopJob.detectSignals(ctx)
      expect(fired).not.toContain("repeat_loop")
    }))

  test("does not fire when fewer than 3 messages have tool parts", () =>
    runtime.run(async () => {
      const ctx = await makeCtx(3, [
        makeUserWrapper(),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
        makeAssistant([makeTool("Read", { path: "/a" }, "completed")]),
      ])
      const fired = await LoopJob.detectSignals(ctx)
      expect(fired).not.toContain("repeat_loop")
    }))
})

describe("loop-signals: repeat_loop_injector job", () => {
  test("is collected when repeat_loop signal fires", () =>
    runtime.run(async () => {
      const ctx = await makeCtx(3, [
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
    }))
})

describe("loop-signals: compact signal", () => {
  test("detects when compaction part exists", () =>
    runtime.run(async () => {
      const ctx = await makeCtx(
        1,
        [makeUserWrapper()],
        [{ id: "p1", sessionID: "ses_test", messageID: "m1", type: "compaction", auto: false }],
      )
      const fired = await LoopJob.detectSignals(ctx)
      expect(fired).toContain("compact")
    }))

  test("does not detect when no compaction part", () =>
    runtime.run(async () => {
      const ctx = await makeCtx(
        1,
        [makeUserWrapper()],
        [{ id: "p1", sessionID: "ses_test", messageID: "m1", type: "text", text: "hello" }],
      )
      const fired = await LoopJob.detectSignals(ctx)
      expect(fired).not.toContain("compact")
    }))

  test("coexists with repeat_loop without interference", () =>
    runtime.run(async () => {
      const ctx = await makeCtx(
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
    }))
})

describe("loop-signals: tool_failure_pattern (scholar search)", () => {
  test("fires after consecutive no-result scholar searches", () =>
    runtime.run(async () => {
      const ctx = await makeCtx(
        2,
        [
          makeUserWrapper("scholar"),
          makeAssistant(
            [
              makeTool("webfetch", { url: "https://example.com/very-specific-paper-xyz" }, "completed", {
                output: "No search results found. Please try a different query.",
                metadata: { searchFailureType: "no_results" },
              }),
            ],
            "scholar",
          ),
          makeAssistant(
            [
              makeTool("webfetch", { url: "https://example.com/papers/very-specific-paper-xyz" }, "completed", {
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
    }))

  test("does not fire for non-scholar agents", () =>
    runtime.run(async () => {
      const ctx = await makeCtx(2, [
        makeUserWrapper(),
        makeAssistant([
          makeTool("webfetch", { url: "https://example.com/missing-one" }, "completed", {
            output: "No search results found. Please try a different query.",
            metadata: { searchFailureType: "no_results" },
          }),
        ]),
        makeAssistant([
          makeTool("webfetch", { url: "https://example.com/missing-two" }, "completed", {
            output: "No search results found. Please try a different query.",
            metadata: { searchFailureType: "no_results" },
          }),
        ]),
      ])

      const fired = await LoopJob.detectSignals(ctx)
      expect(fired).not.toContain("tool_failure_pattern")
    }))

  test("fires early stop after reflection and continued failures", () =>
    runtime.run(async () => {
      // The early-stop check is independent: it only checks the earlyStopMarker,
      // not the reflectionMarker. So having the reflection marker present won't block it.
      const reflectionMarker = makeTextPart("[Search failure reflection]\nPrevious search failed.")
      reflectionMarker.synthetic = true

      const ctx = await makeCtx(
        4,
        [
          makeUserWrapper("scholar"),
          makeAssistant(
            [
              makeTool("webfetch", { url: "https://example.com/a" }, "completed", {
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
              makeTool("webfetch", { url: "https://example.com/b" }, "completed", {
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
    }))
})

afterRuntimeTests(() => runtime.close())
