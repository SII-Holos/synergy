import { afterAll, describe, expect, test } from "bun:test"
import type { Provider } from "../../src/provider/provider"
import { PromptBudgeter } from "../../src/session/prompt-budgeter"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
const model = { id: "fixture", providerID: "fixture", api: { id: "fixture" }, options: {} } as Provider.Model
const plan: PromptBudgeter.PromptPlan = {
  system: ["stable instructions"],
  lateSystem: ["stable environment"],
  messages: [{ role: "user", content: "Do not edit until approved" }],
  toolDefinitions: [{ id: "read", description: "Read", inputSchema: { type: "object" } }],
}
const usage = { input: 100_000, output: 100, reasoning: 50, cache: { read: 20_000, write: 10_000 } }

describe("PromptBudgeter calibration", () => {
  test("uses compatible provider usage, including cached input, and the unified delta meter", () =>
    runtime.run(async () => {
      const snapshot = await PromptBudgeter.snapshot(plan, model)
      const baseline = PromptBudgeter.withUsage(snapshot, usage)
      const next: PromptBudgeter.PromptPlan = {
        ...plan,
        messages: [...plan.messages, { role: "assistant", content: "observed result" }],
      }
      const measured = await PromptBudgeter.measure(next, model.id)
      expect(await PromptBudgeter.calibrate(next, model, baseline)).toEqual({
        actualInput: 130_000,
        outputTokens: 0,
        deltaTokens: measured.total - snapshot.estimatedTokens,
      })
    }))

  test("rejects changed envelopes, models, corrections, pruning and compaction", () =>
    runtime.run(async () => {
      const baseline = PromptBudgeter.withUsage(await PromptBudgeter.snapshot(plan, model), usage)
      const changes: PromptBudgeter.PromptPlan[] = [
        { ...plan, system: ["different instructions"] },
        { ...plan, lateSystem: ["different environment"] },
        { ...plan, toolDefinitions: [] },
        { ...plan, messages: [{ role: "user", content: "corrected request" }] },
        { ...plan, messages: [{ role: "assistant", content: "compacted summary" }] },
        { ...plan, messages: [] },
      ]
      for (const changed of changes) expect(await PromptBudgeter.calibrate(changed, model, baseline)).toBeUndefined()
      expect(await PromptBudgeter.calibrate(plan, { ...model, providerID: "other" }, baseline)).toBeUndefined()
      expect(
        await PromptBudgeter.calibrate(plan, { ...model, api: { ...model.api, id: "other" } }, baseline),
      ).toBeUndefined()
    }))

  test("requires a new usage baseline after replacement or a large delta", () =>
    runtime.run(async () => {
      expect(await PromptBudgeter.calibrate(plan, model)).toBeUndefined()
      const snapshot = await PromptBudgeter.snapshot(plan, model)
      expect(PromptBudgeter.withUsage(snapshot, { ...usage, input: 0, cache: { read: 0, write: 0 } })).toBeUndefined()
      const baseline = PromptBudgeter.withUsage(snapshot, { ...usage, input: 100, cache: { read: 0, write: 0 } })
      const next: PromptBudgeter.PromptPlan = {
        ...plan,
        messages: [...plan.messages, { role: "assistant", content: "new evidence ".repeat(2000) }],
      }
      expect(await PromptBudgeter.calibrate(next, model, baseline)).toBeUndefined()
      const replacement = { ...plan, messages: next.messages.slice(1) }
      const fresh = PromptBudgeter.withUsage(await PromptBudgeter.snapshot(replacement, model), usage)
      expect(await PromptBudgeter.calibrate(replacement, model, fresh)).toMatchObject({
        actualInput: 130_000,
        deltaTokens: 0,
      })
    }))

  test("ciphertext expansion cannot inflate the calibrated delta", () =>
    runtime.run(async () => {
      const baseline = PromptBudgeter.withUsage(await PromptBudgeter.snapshot(plan, model), usage)
      const deltas: number[] = []
      for (const length of [32, 300_000]) {
        const next: PromptBudgeter.PromptPlan = {
          ...plan,
          messages: [
            ...plan.messages,
            {
              role: "assistant",
              content: [
                {
                  type: "reasoning",
                  text: "",
                  providerOptions: {
                    openai: { itemId: "opaque", reasoningEncryptedContent: "x".repeat(length) },
                  },
                },
              ],
            },
          ],
        }
        const calibration = await PromptBudgeter.calibrate(next, model, baseline)
        expect(calibration).toBeDefined()
        deltas.push(calibration!.deltaTokens)
      }
      expect(deltas[0]).toBe(deltas[1])
    }))
})

afterAll(() => runtime.close())
