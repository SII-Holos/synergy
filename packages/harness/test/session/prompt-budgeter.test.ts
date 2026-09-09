import { afterEach, describe, expect, mock, test } from "bun:test"
import { PromptBudgeter } from "../../src/session/prompt-budgeter"
import type { Provider } from "../../src/provider/provider"
import { Token } from "../../src/util/token"

const originalEstimateModelJSON = Token.estimateModelJSON

afterEach(() => {
  ;(Token.estimateModelJSON as any) = originalEstimateModelJSON
})

function createModel(limit?: Provider.Model["limit"]): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test Model",
    limit,
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai", id: "gpt-5" },
    options: {},
  } as Provider.Model
}

describe("prompt-budgeter budget", () => {
  test("reserves long output capacity for shared-context models", () => {
    const result = PromptBudgeter.budget({ context: 1_048_576, output: 384_000 })
    expect(result.usable).toBe(1_048_576)
    expect(result.output).toBe(384_000)
    expect(result.margin).toBe(32_000)
    expect(result.inputEnvelope).toBe(632_576)
    expect(result.soft).toBe(537_689)
  })

  test("keeps explicit input partitions as the compaction budget", () => {
    const result = PromptBudgeter.budget({ context: 400_000, input: 272_000, output: 128_000 })
    expect(result.usable).toBe(272_000)
    expect(result.inputEnvelope).toBe(272_000)
    expect(result.soft).toBe(231_200)
  })

  test("does not reserve the entire window for fully shared output limits", () => {
    const result = PromptBudgeter.budget({ context: 262_144, output: 262_144 })
    expect(result.inputEnvelope).toBe(262_144)
    expect(result.soft).toBe(Math.floor(262_144 * 0.85))
  })

  test("treats near-window output limits as shared instead of deriving a zero threshold", () => {
    const result = PromptBudgeter.budget({ context: 131_072, output: 129_024 })
    expect(result.inputEnvelope).toBe(131_072)
    expect(result.soft).toBe(Math.floor(131_072 * 0.85))
  })

  test("respects overflow threshold override", () => {
    const result = PromptBudgeter.budget({ context: 100_000, output: 8_192 }, { overflowThreshold: 0.95 })
    expect(result.soft).toBe(Math.floor((100_000 - 8_192 - 5_000) * 0.95))
  })
})

describe("prompt-budgeter decision", () => {
  test("does not compact when prompt stays below threshold", async () => {
    const model = createModel({ context: 100_000, output: 8_192 })
    const plan: PromptBudgeter.PromptPlan = {
      system: ["You are helpful."],
      messages: [{ role: "user", content: "short request" }],
      toolDefinitions: [],
    }
    const result = await PromptBudgeter.decide(plan, model.limit, model.id)
    expect(result.shouldCompact).toBe(false)
  })

  test("compacts DeepSeek-sized prompts before they consume the long-output reserve", async () => {
    const model = createModel({ context: 1_048_576, output: 384_000 })
    const plan: PromptBudgeter.PromptPlan = {
      system: ["You are helpful."],
      messages: [{ role: "user", content: "continue" }],
      toolDefinitions: [],
    }

    const result = await PromptBudgeter.decide(plan, model.limit, model.id, {
      calibration: { actualInput: 683_111, outputTokens: 0, deltaTokens: 0 },
    })

    expect(result.shouldCompact).toBe(true)
    expect(result.maxOutputTokens).toBe(333_465)
  })

  test("preserves full GPT output at the explicit-input compaction threshold", async () => {
    const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
    const plan: PromptBudgeter.PromptPlan = {
      system: ["You are helpful."],
      messages: [{ role: "user", content: "continue" }],
      toolDefinitions: [],
    }

    const result = await PromptBudgeter.decide(plan, model.limit, model.id, {
      calibration: { actualInput: 231_200, outputTokens: 0, deltaTokens: 0 },
    })

    expect(result.shouldCompact).toBe(true)
    expect(result.maxOutputTokens).toBe(128_000)
  })

  test("uses an explicit output limit for both reserve and request clamping", async () => {
    const model = createModel({ context: 1_048_576, output: 384_000 })
    const plan: PromptBudgeter.PromptPlan = {
      system: ["You are helpful."],
      messages: [{ role: "user", content: "continue" }],
      toolDefinitions: [],
    }

    const result = await PromptBudgeter.decide(plan, model.limit, model.id, {
      maxOutputTokens: 8_000,
      calibration: { actualInput: 700_000, outputTokens: 0, deltaTokens: 0 },
    })

    expect(result.shouldCompact).toBe(false)
    expect(result.maxOutputTokens).toBe(8_000)
  })

  test("reports when a known context window leaves no response space", async () => {
    const model = createModel({ context: 100_000, output: 8_192 })
    const plan: PromptBudgeter.PromptPlan = {
      system: ["You are helpful."],
      messages: [{ role: "user", content: "continue" }],
      toolDefinitions: [],
    }

    const result = await PromptBudgeter.decide(plan, model.limit, model.id, {
      calibration: { actualInput: 98_000, outputTokens: 0, deltaTokens: 0 },
    })

    expect(result.shouldCompact).toBe(true)
    expect(result.contextExceeded).toBe(true)
    expect(result.maxOutputTokens).toBeUndefined()
  })

  test("keeps legacy output fallback when context metadata is unavailable", async () => {
    const model = createModel(undefined)
    const plan: PromptBudgeter.PromptPlan = {
      system: ["You are helpful."],
      messages: [{ role: "user", content: "continue" }],
      toolDefinitions: [],
    }

    const result = await PromptBudgeter.decide(plan, model.limit, model.id, {
      calibration: { actualInput: 98_000, outputTokens: 0, deltaTokens: 0 },
    })

    expect(result.contextExceeded).toBe(false)
    expect(result.maxOutputTokens).toBeUndefined()
  })

  test("preserves an explicit output limit when context metadata is unavailable", async () => {
    const model = createModel(undefined)
    const plan: PromptBudgeter.PromptPlan = {
      system: ["You are helpful."],
      messages: [{ role: "user", content: "continue" }],
      toolDefinitions: [],
    }

    const result = await PromptBudgeter.decide(plan, model.limit, model.id, {
      maxOutputTokens: 4_000,
      calibration: { actualInput: 98_000, outputTokens: 0, deltaTokens: 0 },
    })

    expect(result.contextExceeded).toBe(false)
    expect(result.maxOutputTokens).toBe(4_000)
  })

  test("larger assembled prompts produce larger measured totals", async () => {
    const model = createModel({ context: 8_000, output: 1_000 })
    const smallPlan: PromptBudgeter.PromptPlan = {
      system: ["You are helpful."],
      messages: [{ role: "user", content: "short request" }],
      toolDefinitions: [],
    }
    const largePlan: PromptBudgeter.PromptPlan = {
      system: ["system ".repeat(300)],
      messages: [{ role: "user", content: "user ".repeat(1800) }],
      toolDefinitions: [
        {
          id: "big_tool",
          description: "d".repeat(800),
          inputSchema: {
            type: "object",
            properties: {
              payload: {
                type: "string",
                description: "x".repeat(2000),
              },
            },
          },
        },
      ],
    }
    const small = await PromptBudgeter.decide(smallPlan, model.limit, model.id, {
      overflowThreshold: 0.5,
    })
    const large = await PromptBudgeter.decide(largePlan, model.limit, model.id, {
      overflowThreshold: 0.5,
    })
    expect(large.measure.total).toBeGreaterThan(small.measure.total)
    expect(large.budget.usable).toBe(small.budget.usable)
  })

  test("reuses cached message estimates across repeated decisions", async () => {
    const model = createModel({ context: 100_000, output: 8_192 })
    const unique = crypto.randomUUID()
    const plan: PromptBudgeter.PromptPlan = {
      system: [`system ${unique}`],
      messages: [
        { role: "user", content: `first ${unique}` },
        { role: "assistant", content: `second ${unique}` },
      ],
      toolDefinitions: [],
    }
    const estimate = mock(async (_modelID: string, value: unknown) => String(value).length)
    ;(Token.estimateModelJSON as any) = estimate

    await PromptBudgeter.decide(plan, model.limit, model.id)
    const firstCallCount = estimate.mock.calls.length
    expect(firstCallCount).toBeGreaterThan(0)
    expect(estimate.mock.calls.every((call) => typeof call[1] === "string")).toBe(true)

    await PromptBudgeter.decide(plan, model.limit, model.id)
    expect(estimate.mock.calls).toHaveLength(firstCallCount)
  })

  test("estimates history messages serially to bound peak tokenization allocations", async () => {
    const model = createModel({ context: 100_000, output: 8_192 })
    const unique = crypto.randomUUID()
    const plan: PromptBudgeter.PromptPlan = {
      system: [`system ${unique}`],
      messages: [
        { role: "user", content: `first ${unique}` },
        { role: "assistant", content: `second ${unique}` },
        { role: "user", content: `third ${unique}` },
      ],
      toolDefinitions: [],
    }
    let active = 0
    let maxActive = 0
    const estimate = mock(async (_modelID: string, value: unknown) => {
      expect(typeof value).toBe("string")
      active++
      maxActive = Math.max(maxActive, active)
      await Bun.sleep(5)
      active--
      return String(value).length
    })
    ;(Token.estimateModelJSON as any) = estimate

    await PromptBudgeter.decide(plan, model.limit, model.id)

    expect(estimate.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(maxActive).toBe(1)
  })
})
