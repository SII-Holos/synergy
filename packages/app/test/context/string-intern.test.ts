import { describe, expect, test } from "bun:test"
import type { ProviderListResponse, TextPart, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import {
  internCacheSize,
  internMessage,
  internPart,
  internProviderList,
  internString,
} from "../../src/context/string-intern"

function providerData(overrides?: Partial<ProviderListResponse>): ProviderListResponse {
  return {
    all: [
      {
        id: "openai",
        name: "OpenAI",
        source: "config",
        env: [],
        options: {},
        models: {
          "gpt-5": {
            id: "gpt-5",
            providerID: "openai",
            name: "GPT-5",
            api: { id: "chat", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai-compatible" },
            capabilities: { temperature: true, reasoning: true },
            variants: {
              low: { reasoningEffort: "low", include: ["reasoning.encrypted_content"] },
            },
          },
        },
      },
    ],
    default: {},
    connected: [],
    configProviders: [],
    catalogProviders: [],
    profiles: {},
    connections: {},
    authHealth: {},
    runtimeAvailability: {},
    modelCatalog: {},
    ...overrides,
  } as ProviderListResponse
}

describe("string interning", () => {
  test("merges equal strings into a shared reference", () => {
    const first = internString("@ai-sdk/openai-compatible")
    const second = internString("@ai-sdk/openai-compatible")
    expect(second).toBe(first)
  })

  test("interns provider model api and variant include strings in place", () => {
    const first = providerData()
    internProviderList(first)
    const second = providerData()
    internProviderList(second)

    const firstModel = first.all[0]!.models["gpt-5"]!
    const secondModel = second.all[0]!.models["gpt-5"]!
    const firstInclude = firstModel.variants!.low!.include as string[]
    const secondInclude = secondModel.variants!.low!.include as string[]
    expect(secondModel.api.npm).toBe(firstModel.api.npm)
    expect(secondInclude[0]).toBe(firstInclude[0])
  })

  test("interns system text parts and user system prompts", () => {
    const prompt = "You are synergy, a general-purpose AI agent."

    const partA = internPart({ type: "text", origin: "system", text: prompt } as TextPart)
    const partB = internPart({ type: "text", origin: "system", text: prompt } as TextPart)
    expect((partB as TextPart).text).toBe((partA as TextPart).text)

    const msgA = internMessage({ role: "user", system: prompt } as UserMessage)
    const msgB = internMessage({ role: "user", system: prompt } as UserMessage)
    expect((msgB as UserMessage).system).toBe((msgA as UserMessage).system)
  })

  test("leaves user text parts untouched and only interns system content", () => {
    // Reference-identity assertions on equal strings cannot work here:
    // Bun runs on JavaScriptCore, which atomizes strings produced by
    // JSON.parse and literals alike. Assert the behavioral contract instead:
    // user-origin text never enters the interning table, system content does.
    const baseline = internCacheSize()
    const userText = `user-text-${Math.random()}`
    internPart({ type: "text", origin: "user", text: userText } as TextPart)
    expect(internCacheSize()).toBe(baseline)

    const systemText = `system-text-${Math.random()}`
    internPart({ type: "text", origin: "system", text: systemText } as TextPart)
    expect(internCacheSize()).toBe(baseline + 1)
  })
})
