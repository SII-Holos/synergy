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

test("repeated tools and failures preserve the root and let the model continue", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        for (const [tool, status, count, agent] of [
          ["read", "completed", 6, PrimaryAgentIdentity.names.coding],
          ["bash", "error", 12, PrimaryAgentIdentity.names.coding],
          ["webfetch", "error", 5, "scholar"],
        ] as const) {
          const ctx = await makeCtx(
            count,
            [
              makeUserWrapper(agent),
              ...Array.from({ length: count }, () =>
                makeAssistant([makeTool(tool, { url: "https://example.test", path: "fixture.txt" }, status)], agent),
              ),
            ],
            [makeTextPart("Continue the requested task.")],
            agent,
          )
          const before = await MessageV2.parts({ sessionID: ctx.sessionID, messageID: ctx.lastUser.id })
          const signals = await LoopJob.detectSignals(ctx)
          expect(await LoopJob.execute(LoopJob.collect("pre", ctx, signals), ctx)).toBe("pass")
          expect(await MessageV2.parts({ sessionID: ctx.sessionID, messageID: ctx.lastUser.id })).toEqual(before)
        }
      },
    }),
  ))

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
})

afterRuntimeTests(() => runtime.close())
