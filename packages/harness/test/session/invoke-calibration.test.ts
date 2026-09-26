import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { describe, expect, test } from "bun:test"
import { SessionInvoke } from "../../src/session/invoke"
import type { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "../../src/provider/provider"

function model(overrides: Partial<Provider.Model> = {}): Provider.Model {
  return {
    id: "fast-model",
    providerID: "gateway",
    capabilities: { interleaved: false },
    ...overrides,
  } as Provider.Model
}

function noTokens() {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function assistant(tokens: ReturnType<typeof noTokens>, extra: Record<string, unknown> = {}): MessageV2.WithParts {
  return {
    info: { role: "assistant", providerID: "gateway", modelID: "fast-model", tokens, ...extra },
    parts: [],
  } as unknown as MessageV2.WithParts
}

function withParts(parts: unknown[]): MessageV2.WithParts {
  return {
    info: { role: "assistant", providerID: "gateway", modelID: "fast-model", tokens: noTokens() },
    parts,
  } as unknown as MessageV2.WithParts
}

describe("SessionInvoke.buildCalibration", () => {
  test("counts reasoning appended after the anchor", () =>
    runtime.run(() => {
      const tokens = { input: 1000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }
      const calibration = SessionInvoke.buildCalibration(
        [assistant(tokens), withParts([{ type: "reasoning", text: "x".repeat(400) }])],
        model(),
      )
      expect(calibration).toBeDefined()
      expect(calibration!.actualInput).toBe(1000)
      expect(calibration!.deltaTokens).toBe(100)
    }))

  test("ignores an anchor reported by a different model", () =>
    runtime.run(() => {
      const tokens = { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      const msgs = [assistant(tokens, { providerID: "other-gateway", modelID: "other-model" })]
      expect(SessionInvoke.buildCalibration(msgs, model())).toBeUndefined()
    }))

  test("declines calibration once the estimated delta dwarfs the anchor", () =>
    runtime.run(() => {
      const tokens = { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      // 8000 chars ≈ 2000 tokens of delta against a 1000-token baseline: the
      // chars/4 heuristic is no longer trustworthy, so measurement must run.
      const msgs = [assistant(tokens), withParts([{ type: "reasoning", text: "x".repeat(8000) }])]
      expect(SessionInvoke.buildCalibration(msgs, model())).toBeUndefined()
    }))

  test("returns no calibration without a provider-reported anchor", () =>
    runtime.run(() => {
      const msgs = [assistant(noTokens()), withParts([{ type: "text", text: "hello" }])]
      expect(SessionInvoke.buildCalibration(msgs, model())).toBeUndefined()
    }))
})

afterRuntimeTests(() => runtime.close())
