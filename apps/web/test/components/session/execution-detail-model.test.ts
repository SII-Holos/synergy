import { expect, test } from "bun:test"
import {
  executionDetailAvailable,
  executionDetailState,
  executionDetailSelection,
} from "../../../src/components/session/execution-detail-model"
const owner = { server: "https://server.test", scope: "scope", sessionID: "session" }
const first = { sessionID: "session", messageID: "message-a", partID: "part-a", callID: "call-a" }
test("execution selection stays on the explicit invocation even with old follow state", () => {
  const state = executionDetailState({ ...owner, ...first, followLatest: true }, owner)!
  expect(executionDetailSelection(state as Extract<typeof state, { kind: "tool" }>)).toEqual(first)
  expect(state).not.toHaveProperty("followLatest")
})
test("restored detail refuses foreign connections, scopes and sessions", () => {
  const state = { ...owner, ...first }
  expect(executionDetailState(state, owner)).toEqual({ ...state, kind: "tool" })
  for (const field of ["server", "scope", "sessionID"] as const)
    expect(executionDetailState({ ...state, [field]: "foreign" }, owner)).toBeUndefined()
  expect(executionDetailState({ ...state, partID: "" }, owner)).toBeUndefined()
})
test("system event selections do not require a tool part and reject unknown kinds", () => {
  for (const kind of ["agent-delivery", "compaction"] as const) {
    const value = { ...owner, messageID: "event", kind }
    expect(executionDetailState(value, owner)).toEqual(value)
  }
  expect(executionDetailState({ ...owner, ...first, kind: "unknown" }, owner)).toBeUndefined()
})

test("execution detail keeps owner requirements across restore without hiding ordinary tools or events", () => {
  const state = executionDetailState({ ...owner, ...first, requiredFeatures: ["note", "blueprint"] }, owner)!
  expect(state).toHaveProperty("requiredFeatures", ["note", "blueprint"])
  expect(executionDetailAvailable(state, () => false)).toBe(false)
  expect(executionDetailAvailable(state, (id) => id === "note")).toBe(false)
  expect(executionDetailAvailable(state, () => true)).toBe(true)
  expect(executionDetailAvailable({ ...owner, ...first, requiredFeatures: [] }, () => false)).toBe(true)
  expect(executionDetailAvailable({ ...owner, ...first }, () => false)).toBe(true)
  expect(executionDetailAvailable({ ...owner, messageID: "message", kind: "compaction" }, () => false)).toBe(true)
})
