import { describe, expect, test, beforeAll } from "bun:test"
import { LoopJob } from "../../src/session/loop-job"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import type { MessageV2 } from "../../src/session/message-v2"
import type { Info } from "../../src/session/types"
import type { Scope } from "../../src/scope/types"

Log.init({ print: false })

// ─── helpers ───────────────────────────────────────────────────────

function makeUserMsg(overrides?: Partial<MessageV2.User>): MessageV2.User {
  return {
    id: Identifier.ascending("message"),
    role: "user" as const,
    sessionID: "ses_test",
    time: { created: Date.now() },
    agent: "synergy",
    model: { providerID: "test-provider", modelID: "test-model" },
    ...overrides,
  } as MessageV2.User
}

function makeSession(): Info {
  return {
    id: Identifier.ascending("session"),
    scope: { id: "scope_test", directory: "/tmp" } as Scope,
    title: "Test Session",
    version: "1",
    time: { created: Date.now(), updated: Date.now() },
  } as Info
}

function makeContext(overrides: Partial<LoopJob.Context>): LoopJob.Context {
  return {
    session: makeSession(),
    sessionID: "ses_test",
    step: 1,
    messages: [],
    lastUser: makeUserMsg(),
    lastUserParts: [],
    abort: new AbortController().signal,
    modelLimits: { context: 200_000, output: 8_192 },
    ...overrides,
  }
}

// ─── import signals (registers them into LoopJob) ──────────────────

beforeAll(async () => {
  await import("../../src/session/loop-signals")
})

// ─── tests ─────────────────────────────────────────────────────────

describe("loop-signals: compact signal", () => {
  test("detects when compaction part exists", async () => {
    const ctx = makeContext({
      lastUserParts: [
        {
          id: "part_1",
          sessionID: "ses_test",
          messageID: "msg_1",
          type: "compaction",
          auto: false,
        } as MessageV2.CompactionPart,
      ],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("compact")
  })

  test("does not detect when no compaction part", async () => {
    const ctx = makeContext({
      lastUserParts: [
        { id: "part_1", sessionID: "ses_test", messageID: "msg_1", type: "text", text: "hello" } as MessageV2.TextPart,
      ],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("compact")
  })

  test("coexists with non-compaction guards", async () => {
    const ctx = makeContext({
      step: 5,
      lastUserParts: [
        {
          id: "part_1",
          sessionID: "ses_test",
          messageID: "msg_1",
          type: "compaction",
          auto: true,
        } as MessageV2.CompactionPart,
      ],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("compact")
    expect(fired).not.toContain("error_loop")
  })
})
