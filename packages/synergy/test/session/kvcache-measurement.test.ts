import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import type { Provider } from "../../src/provider/provider"
import { LLM } from "../../src/session/llm"

function createModel(provider: "openai" | "anthropic" = "openai"): Provider.Model {
  return {
    id: provider === "openai" ? "openai/gpt-5" : "anthropic/claude-3-5-sonnet",
    providerID: provider,
    api: {
      id: provider === "openai" ? "gpt-5" : "claude-3-5-sonnet-20241022",
      url: provider === "openai" ? "https://api.openai.com" : "https://api.anthropic.com",
      npm: provider === "openai" ? "@ai-sdk/openai" : "@ai-sdk/anthropic",
    },
    name: provider,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 32_000 },
    status: "active",
    options: {},
  } as Provider.Model
}

const stableSystem = ["CORE: agent prompt", "PROJECT: AGENTS instructions", "PERMISSION: guarded tool policy"]
const history: ModelMessage[] = [
  { role: "user", content: "USER: first request" },
  { role: "assistant", content: "ASSISTANT: first answer" },
]

function lateSystem(turn: "a" | "b") {
  return [`MEMORY: recalled item ${turn}`, `ENV: time ${turn}`]
}

function serialize(messages: ModelMessage[]) {
  return JSON.stringify(messages)
}

function commonPrefixLength(a: string, b: string) {
  let index = 0
  while (index < a.length && index < b.length && a[index] === b[index]) index++
  return index
}

function openAIMessages(turn: "a" | "b") {
  return LLM.promptMessages({
    model: createModel("openai"),
    system: stableSystem,
    lateSystem: lateSystem(turn),
    messages: history,
  })
}

describe("KV-cache measurement prompt-shape harness", () => {
  test("production OpenAI-style layout preserves stable prefix through reusable history", () => {
    const first = openAIMessages("a")
    const second = openAIMessages("b")
    const stablePrefix = serialize([
      ...stableSystem.map((content) => ({ role: "system", content })),
      ...history,
    ] as ModelMessage[])

    expect(first.map((message) => message.role)).toEqual(["system", "system", "system", "user", "assistant", "user"])
    expect(commonPrefixLength(serialize(first), serialize(second))).toBeGreaterThanOrEqual(stablePrefix.length - 1)
  })

  test("production OpenAI-style layout appends volatile advisory context after history", () => {
    const messages = openAIMessages("a")
    const late = messages.at(-1)

    expect(messages[3]).toEqual(history[0])
    expect(messages[4]).toEqual(history[1])
    expect(late?.role).toBe("user")
    expect(String(late?.content)).toContain("<runtime-context>")
    expect(String(late?.content)).toContain("MEMORY: recalled item a")
    expect(String(late?.content)).toContain("ENV: time a")
  })

  test("production layout keeps tool-call history before volatile advisory context", () => {
    const messages = LLM.promptMessages({
      model: createModel("openai"),
      system: stableSystem,
      lateSystem: lateSystem("a"),
      messages: [
        ...history,
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "pwd" } }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "call_1", toolName: "bash", output: "C:/repo" }],
        },
      ] as ModelMessage[],
    })

    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
      "assistant",
      "assistant",
      "tool",
      "user",
    ])
    expect(messages.at(-1)?.role).toBe("user")
    expect(String(messages.at(-1)?.content)).toContain("<runtime-context>")
  })

  test("Anthropic layout keeps the stable breakpoint before volatile advisory system blocks", () => {
    const messages = LLM.promptMessages({
      model: createModel("anthropic"),
      system: stableSystem,
      lateSystem: lateSystem("a"),
      messages: history,
    })

    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
      "system",
      "system",
      "user",
      "assistant",
    ])
    expect(messages[2]).toEqual({ role: "system", content: "PERMISSION: guarded tool policy" })
    expect(messages[3]).toEqual({ role: "system", content: "MEMORY: recalled item a" })
    expect(messages[4]).toEqual({ role: "system", content: "ENV: time a" })
  })
})
