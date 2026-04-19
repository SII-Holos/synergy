import { describe, expect, test } from "bun:test"
import { PromptBudgeter } from "../../src/session/prompt-budgeter"
import type { Provider } from "../../src/provider/provider"

function createModel(limit: Provider.Model["limit"]): Provider.Model {
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
  test("uses shared context minus output reserve", () => {
    const result = PromptBudgeter.budget({ context: 202_752, output: 32_768 }, { outputTokenMax: 32_000 })
    expect(result.usable).toBe(170_752)
    expect(result.soft).toBe(Math.floor(170_752 * 0.85))
  })

  test("uses input cap with compaction buffer", () => {
    const result = PromptBudgeter.budget(
      { context: 400_000, input: 272_000, output: 128_000 },
      { outputTokenMax: 32_000 },
    )
    expect(result.usable).toBe(252_000)
  })

  test("respects overflow threshold override", () => {
    const result = PromptBudgeter.budget(
      { context: 100_000, output: 8_192 },
      { outputTokenMax: 32_000, overflowThreshold: 0.95 },
    )
    expect(result.soft).toBe(Math.floor(91_808 * 0.95))
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
    const result = await PromptBudgeter.decide(plan, model.limit, model.id, { outputTokenMax: 32_000 })
    expect(result.shouldCompact).toBe(false)
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
      outputTokenMax: 32_000,
      overflowThreshold: 0.5,
    })
    const large = await PromptBudgeter.decide(largePlan, model.limit, model.id, {
      outputTokenMax: 32_000,
      overflowThreshold: 0.5,
    })
    expect(large.measure.total).toBeGreaterThan(small.measure.total)
    expect(large.budget.usable).toBe(small.budget.usable)
  })
})
