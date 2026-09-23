import { afterEach, describe, expect, mock, test } from "bun:test"
import { PromptBudgeter } from "../../src/session/prompt-budgeter"
import type { Provider } from "../../src/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { Token } from "../../src/util/token"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const originalEstimateModelJSON = Token.estimateModelJSON

afterEach(() =>
  runtime.run(() => {
    ;(Token.estimateModelJSON as any) = originalEstimateModelJSON
  }),
)

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
  test("reserves long output capacity for shared-context models", () =>
    runtime.run(() => {
      const result = PromptBudgeter.budget({ context: 1_048_576, output: 384_000 })
      expect(result.usable).toBe(1_048_576)
      expect(result.output).toBe(384_000)
      expect(result.margin).toBe(32_000)
      expect(result.inputEnvelope).toBe(632_576)
      expect(result.soft).toBe(537_689)
    }))

  test("keeps explicit input partitions as the compaction budget", () =>
    runtime.run(() => {
      const result = PromptBudgeter.budget({ context: 400_000, input: 272_000, output: 128_000 })
      expect(result.usable).toBe(272_000)
      expect(result.inputEnvelope).toBe(272_000)
      expect(result.soft).toBe(231_200)
    }))

  test("does not reserve the entire window for fully shared output limits", () =>
    runtime.run(() => {
      const result = PromptBudgeter.budget({ context: 262_144, output: 262_144 })
      expect(result.inputEnvelope).toBe(262_144)
      expect(result.soft).toBe(Math.floor(262_144 * 0.85))
    }))

  test("treats near-window output limits as shared instead of deriving a zero threshold", () =>
    runtime.run(() => {
      const result = PromptBudgeter.budget({ context: 131_072, output: 129_024 })
      expect(result.inputEnvelope).toBe(131_072)
      expect(result.soft).toBe(Math.floor(131_072 * 0.85))
    }))

  test("respects overflow threshold override", () =>
    runtime.run(() => {
      const result = PromptBudgeter.budget({ context: 100_000, output: 8_192 }, { overflowThreshold: 0.95 })
      expect(result.soft).toBe(Math.floor((100_000 - 8_192 - 5_000) * 0.95))
    }))
})

describe("prompt-budgeter decision", () => {
  test("does not compact when prompt stays below threshold", () =>
    runtime.run(async () => {
      const model = createModel({ context: 100_000, output: 8_192 })
      const plan: PromptBudgeter.PromptPlan = {
        system: ["You are helpful."],
        messages: [{ role: "user", content: "short request" }],
        toolDefinitions: [],
      }
      const result = await PromptBudgeter.decide(plan, model.limit, model.id)
      expect(result.shouldCompact).toBe(false)
    }))

  test("compacts DeepSeek-sized prompts before they consume the long-output reserve", () =>
    runtime.run(async () => {
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
    }))

  test("preserves full GPT output at the explicit-input compaction threshold", () =>
    runtime.run(async () => {
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
    }))

  test("uses an explicit output limit for both reserve and request clamping", () =>
    runtime.run(async () => {
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
    }))

  test("reports when a known context window leaves no response space", () =>
    runtime.run(async () => {
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
    }))

  test("keeps legacy output fallback when context metadata is unavailable", () =>
    runtime.run(async () => {
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
    }))

  test("preserves an explicit output limit when context metadata is unavailable", () =>
    runtime.run(async () => {
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
    }))

  test("larger assembled prompts produce larger measured totals", () =>
    runtime.run(async () => {
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
    }))

  test("does not count encrypted reasoning payload as ordinary prompt text", () =>
    runtime.run(async () => {
      const model = createModel({ context: 100_000, output: 8_192 })
      ;(Token.estimateModelJSON as any) = mock(async (_modelID: string, value: unknown) => String(value).length)
      const reasoning = {
        role: "assistant" as const,
        content: [
          {
            type: "reasoning" as const,
            text: "summary",
            providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "a".repeat(10_000) } },
          },
        ],
      }
      const plan: PromptBudgeter.PromptPlan = { system: [], messages: [reasoning], toolDefinitions: [] }
      const measured = await PromptBudgeter.measure(plan, model.id)
      const short = await PromptBudgeter.measure(
        {
          ...plan,
          messages: [
            {
              ...reasoning,
              content: [
                {
                  ...reasoning.content[0],
                  providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "opaque" } },
                },
              ],
            },
          ],
        },
        model.id,
      )
      expect(measured.messages - short.messages).toBe(0)
      expect(reasoning.content[0].providerOptions.openai.reasoningEncryptedContent).toHaveLength(10_000)
    }))

  test("reserves bounded tokens for encrypted reasoning on an uncalibrated first turn", () =>
    runtime.run(async () => {
      const model = createModel({ context: 100_000, output: 8_192 })
      ;(Token.estimateModelJSON as any) = mock(async (_modelID: string, value: unknown) => String(value).length)
      const reasoning = (ciphertext: string) => ({
        role: "assistant" as const,
        content: [
          {
            type: "reasoning" as const,
            text: "summary",
            providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: ciphertext } },
          },
        ],
      })
      const plan = (ciphertext: string): PromptBudgeter.PromptPlan => ({
        system: [],
        messages: [reasoning(ciphertext)],
        toolDefinitions: [],
      })
      const plain = await PromptBudgeter.measure(
        { ...plan("opaque"), messages: [{ role: "assistant", content: [{ type: "reasoning", text: "summary" }] }] },
        model.id,
      )
      const small = await PromptBudgeter.measure(plan("a".repeat(100)), model.id)
      const large = await PromptBudgeter.measure(plan("a".repeat(100_000)), model.id)
      expect(small.messages - plain.messages).toBeGreaterThan(500)
      expect(large.messages - small.messages).toBe(0)
      const calibrated = await PromptBudgeter.decide(plan("opaque"), model.limit, model.id, {
        calibration: { actualInput: 900, outputTokens: 50, deltaTokens: 25 },
      })
      expect(calibrated.measure.total).toBe(975)
    }))

  test("uses producer reasoning usage instead of ciphertext size for uncalibrated replay", () =>
    runtime.run(async () => {
      const model = createModel({ context: 50_000, output: 32_000 })
      ;(Token.estimateModelJSON as any) = mock(async (_modelID: string, value: unknown) => String(value).length)
      const item = (id: string, ciphertext: string) => ({
        type: "reasoning" as const,
        text: "summary",
        providerOptions: { openai: { itemId: id, reasoningEncryptedContent: ciphertext } },
      })
      const plan: PromptBudgeter.PromptPlan = {
        system: [],
        messages: [
          { role: "assistant", content: [item("rs_first", "x".repeat(100_000)), item("rs_second", "opaque")] },
        ],
        toolDefinitions: [],
      }
      const baseline = await PromptBudgeter.measure(plan, model.id)
      const baselineDecision = await PromptBudgeter.decide(plan, model.limit, model.id)
      const measured = await PromptBudgeter.measure(plan, model.id, {
        encryptedReasoningTokens: new Map([
          ["rs_first", 28_000],
          ["rs_second", 4_000],
        ]),
      })
      expect(measured.messages - baseline.messages).toBe(32_000 - 2 * 1_024)
      const decision = await PromptBudgeter.decide(plan, model.limit, model.id, {
        encryptedReasoningTokens: new Map([
          ["rs_first", 28_000],
          ["rs_second", 4_000],
        ]),
      })
      expect(decision.measure.messages).toBe(measured.messages)
      expect(decision.maxOutputTokens).toBeLessThan(baselineDecision.maxOutputTokens!)
      expect(decision.shouldCompact).toBe(true)
    }))

  test("allocates durable producer usage across replayable encrypted items", () =>
    runtime.run(() => {
      const assistant = (
        id: string,
        reasoning: number,
        output: number,
        itemIDs: string[],
        encrypted = true,
      ): MessageV2.WithParts => ({
        info: {
          id,
          sessionID: "session",
          role: "assistant",
          parentID: "user",
          modelID: "model",
          providerID: "openai-codex",
          mode: "",
          agent: "agent",
          time: { created: 0 },
          path: { cwd: null, root: null },
          cost: 0,
          tokens: { input: 100, output, reasoning, cache: { read: 0, write: 0 } },
        },
        parts: itemIDs.map((itemId, index) => ({
          id: `part-${id}-${index}`,
          sessionID: "session",
          messageID: id,
          type: "reasoning",
          text: "summary",
          time: { start: 0, end: 0 },
          metadata: { openai: { itemId, ...(encrypted ? { reasoningEncryptedContent: "opaque" } : {}) } },
        })),
      })
      const first = assistant("first", 24_000, 26_000, ["rs_first", "rs_first", "rs_second"])
      const second = assistant("second", 0, 6_000, ["rs_output_only"])
      const noCipher = assistant("missing", 40_000, 42_000, ["rs_missing"], false)
      const estimates = PromptBudgeter.reasoningReplayTokens([first, second, noCipher])
      expect(estimates.get("rs_first")).toBe(12_000)
      expect(estimates.get("rs_second")).toBe(12_000)
      expect(estimates.get("rs_output_only")).toBe(6_000)
      expect(estimates.has("rs_missing")).toBe(false)
    }))

  test("uses projected Codex history usage in an uncalibrated budget decision", () =>
    runtime.run(async () => {
      const model = createModel({ context: 50_000, output: 32_000 })
      const history: MessageV2.WithParts[] = [
        {
          info: {
            id: "assistant-1",
            sessionID: "session",
            parentID: "user-1",
            role: "assistant",
            providerID: "codex-connection",
            modelID: model.id,
            profileID: "openai-codex",
            apiModelID: model.api.id,
            mode: "",
            agent: "agent",
            time: { created: 0, completed: 1 },
            path: { cwd: null, root: null },
            cost: 0,
            tokens: { input: 100, output: 32_200, reasoning: 32_000, cache: { read: 0, write: 0 } },
          },
          parts: [
            {
              id: "reasoning-1",
              sessionID: "session",
              messageID: "assistant-1",
              type: "reasoning",
              text: "summary",
              time: { start: 0, end: 1 },
              metadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "opaque" } },
            },
          ],
        },
      ]
      const projection = MessageV2.projectModelMessages(history, {
        model: {
          providerID: "codex-connection",
          modelID: model.id,
          profileID: "openai-codex",
          apiModelID: model.api.id,
        },
      })
      const plan: PromptBudgeter.PromptPlan = { system: [], messages: projection.messages, toolDefinitions: [] }
      const fallback = await PromptBudgeter.decide(plan, model.limit, model.id)
      const usage = await PromptBudgeter.decide(plan, model.limit, model.id, {
        encryptedReasoningTokens: PromptBudgeter.reasoningReplayTokens(history),
      })
      expect(usage.measure.messages - fallback.measure.messages).toBe(32_000 - 1_024)
      expect(fallback.shouldCompact).toBe(false)
      expect(usage.shouldCompact).toBe(true)

      const incompatible = MessageV2.projectModelMessages(history, {
        model: { providerID: "codex-connection", modelID: model.id, profileID: "openai-codex", apiModelID: "other" },
      })
      expect(
        await PromptBudgeter.decide({ ...plan, messages: incompatible.messages }, model.limit, model.id, {
          encryptedReasoningTokens: PromptBudgeter.reasoningReplayTokens(history),
        }),
      ).toMatchObject({ shouldCompact: false })
    }))

  test("reuses cached message estimates across repeated decisions", () =>
    runtime.run(async () => {
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
    }))

  test("estimates history messages serially to bound peak tokenization allocations", () =>
    runtime.run(async () => {
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
    }))
})

afterRuntimeTests(() => runtime.close())
