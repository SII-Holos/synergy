import { expect, test } from "bun:test"
import type { AssistantMessage } from "@ericsanchezok/synergy-sdk/client"
import {
  buildContextStatusModel,
  formatContextNumber,
  formatContextPercent,
  type ContextStatusPresentation,
} from "../../../src/components/workspace/context-model"

const presentation: ContextStatusPresentation = {
  statusPartiallyKnown: "Unknown",
  statusCompacting: "Compacting",
  statusCompacted: "Compacted",
  statusCritical: "Critical",
  statusWarning: "Warning",
  statusReady: "Ready",
}
const providers = { provider: { models: { model: { limit: { context: 2000, output: 200 } } } } }
const assistant = (input: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: "msg_assistant",
  sessionID: "ses_context",
  role: "assistant",
  parentID: "msg_user",
  modelID: "model",
  providerID: "provider",
  mode: "agent",
  agent: "test",
  path: { cwd: "/fixture", root: "/fixture" },
  cost: 0,
  tokens: { input: 400, output: 40, reasoning: 60, cache: { read: 80, write: 20 } },
  time: { created: 20, completed: 30 },
  ...input,
})
const snapshot = (totalInput: number): NonNullable<AssistantMessage["contextUsage"]> => ({
  version: 2,
  modelID: "model",
  providerID: "provider",
  totalInput,
  contextLimit: 1000,
  usableInputLimit: 800,
  categories: [],
  overhead: { attributedTokens: totalInput },
  estimator: { kind: "bounded-utf8", sampledCharacters: 0, truncated: false },
  reconciliation: { mode: "residual", factor: 1 },
  capturedAt: 30,
})

test("status uses captured capacity and the authoritative latest projection", () => {
  const model = buildContextStatusModel({
    messages: [assistant({ contextUsage: snapshot(200) })],
    latestMessage: assistant({ contextUsage: snapshot(600) }),
    providers,
    presentation,
  })
  expect(model.usage).toEqual({ exactInputTokens: 600, contextPercentage: 75 })
  expect(model.statusSummary).toBe("Ready")
  expect(
    buildContextStatusModel({ messages: [assistant()], latestMessage: null, providers, presentation }).usage
      .exactInputTokens,
  ).toBeNull()
})
test("status respects context exclusion, imported usage and compaction barriers", () => {
  const previous = assistant({ contextUsage: snapshot(600) })
  const hidden = assistant({ id: "hidden", includeInContext: false, contextUsage: snapshot(100) })
  expect(
    buildContextStatusModel({ messages: [previous, hidden], providers, presentation }).usage.exactInputTokens,
  ).toBe(600)
  const compacted = assistant({ id: "compact", mode: "compaction" })
  const model = buildContextStatusModel({ messages: [previous, compacted], providers, presentation })
  expect(model.usage.exactInputTokens).toBeNull()
  expect(model.statusSummary).toBe("Compacted")
})
test("status reports progress and threshold states", () => {
  const model = (message: AssistantMessage) => buildContextStatusModel({ messages: [message], providers, presentation })
  expect(model(assistant({ contextUsage: snapshot(680) })).statusTone).toBe("warning")
  expect(model(assistant({ contextUsage: snapshot(790) })).statusTone).toBe("critical")
  expect(model(assistant({ mode: "compaction", time: { created: 20 } })).statusTone).toBe("progress")
})
test("unknown input differs from recorded zero and legacy cache tokens count toward input", () => {
  expect(buildContextStatusModel({ messages: [assistant()], providers, presentation }).usage.exactInputTokens).toBe(500)
  expect(
    buildContextStatusModel({ messages: [assistant({ contextUsage: snapshot(0) })], providers, presentation }).usage
      .exactInputTokens,
  ).toBe(0)
  expect(
    buildContextStatusModel({
      messages: [assistant({ tokens: { input: 0, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } })],
      providers,
      presentation,
    }).usage.exactInputTokens,
  ).toBeNull()
  expect(buildContextStatusModel({ messages: [], providers, presentation }).usage.contextPercentage).toBeNull()
  expect(
    buildContextStatusModel({ messages: [assistant()], providers: {}, presentation }).usage.contextPercentage,
  ).toBeNull()
})
test("formatters preserve localized values and missing values", () => {
  expect(formatContextNumber(0, String)).toBe("0")
  expect(formatContextNumber(null, String)).toBe("—")
  expect(formatContextPercent(50, (value) => String(value))).toBe("0.5")
  expect(formatContextPercent(undefined, String)).toBe("—")
})
