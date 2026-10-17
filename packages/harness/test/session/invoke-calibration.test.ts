import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { describe, expect, test } from "bun:test"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionCompaction } from "../../src/session/compaction"
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

  test("remeasures retained pruning without a matching request revision, including legacy anchors", () =>
    runtime.run(() => {
      const old = withParts([
        {
          type: "tool",
          id: "old-result",
          state: { status: "completed", input: {}, output: "retained evidence", time: { compacted: 300 } },
        },
      ])
      const tokens = { input: 1000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }
      expect(
        SessionInvoke.buildCalibration([old, assistant(tokens, { time: { created: 100, completed: 200 } })], model()),
      ).toBeUndefined()
      expect(
        SessionInvoke.buildCalibration([old, assistant(tokens, { time: { created: 400, completed: 500 } })], model()),
      ).toBeUndefined()
    }))

  test("accepts usage for the pruned request even when its assistant was created before pruning", () =>
    runtime.run(() => {
      const old = withParts([
        {
          id: "old-result",
          type: "tool",
          state: { status: "completed", input: {}, output: "evidence", time: { compacted: 300 } },
        },
      ])
      const tokens = { input: 1000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }
      const anchor = assistant(tokens, {
        time: { created: 100, completed: 400 },
        metadata: { promptPruning: SessionCompaction.pruningRevision([old]) },
      })
      expect(SessionInvoke.buildCalibration([old, anchor], model())).toMatchObject({ actualInput: 1000 })
      const changed = structuredClone(old)
      const part = changed.parts[0]
      if (part.type !== "tool" || part.state.status !== "completed") throw new Error("Expected tool fixture")
      part.state.time.compacted = 301
      expect(SessionInvoke.buildCalibration([changed, anchor], model())).toBeUndefined()
    }))
})

afterRuntimeTests(() => runtime.close())
