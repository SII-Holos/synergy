import { describe, expect, test } from "bun:test"
import { ExperienceEncoder } from "../../src/library/experience-encoder"
import { MessageV2 } from "../../src/session/message-v2"

function assistant(overrides: Partial<MessageV2.Assistant> = {}): MessageV2.Assistant {
  return {
    id: "msg_assistant",
    sessionID: "ses_test",
    parentID: "msg_user",
    role: "assistant",
    time: { created: 0 },
    modelID: "model",
    providerID: "provider",
    mode: "agent",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...overrides,
  } as MessageV2.Assistant
}

function memory(
  overrides: Partial<ReturnType<typeof process.memoryUsage>> = {},
): ReturnType<typeof process.memoryUsage> {
  return {
    rss: 128 * 1024 * 1024,
    heapTotal: 64 * 1024 * 1024,
    heapUsed: 32 * 1024 * 1024,
    external: 4 * 1024 * 1024,
    arrayBuffers: 1024,
    ...overrides,
  }
}

describe("ExperienceEncoder", () => {
  test("skips aborted assistant messages", () => {
    expect(
      ExperienceEncoder.__test.shouldEncodeOnComplete(
        assistant({
          error: new MessageV2.AbortedError({ message: "aborted" }).toObject() as MessageV2.Assistant["error"],
        }),
        memory(),
      ),
    ).toBe(false)
  })

  test("skips non-abort errored assistant messages", () => {
    expect(
      ExperienceEncoder.__test.shouldEncodeOnComplete(
        assistant({
          error: { name: "ProviderError", data: { message: "failed" } } as unknown as MessageV2.Assistant["error"],
        }),
        memory(),
      ),
    ).toBe(false)
  })

  test("keeps completed assistant messages eligible for encoding", () => {
    expect(ExperienceEncoder.__test.shouldEncodeOnComplete(assistant({ finish: "stop" }), memory())).toBe(true)
  })

  test("skips completed assistant messages under high ArrayBuffer pressure", () => {
    expect(
      ExperienceEncoder.__test.shouldEncodeOnComplete(
        assistant({ finish: "stop" }),
        memory({ arrayBuffers: 2 * 1024 * 1024 * 1024 }),
      ),
    ).toBe(false)
  })
})
