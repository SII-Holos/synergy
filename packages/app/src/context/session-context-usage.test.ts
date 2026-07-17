import { describe, expect, test } from "bun:test"
import {
  findLatestSessionContextUsageMessage,
  invalidateLatestSessionContextUsageMessage,
  isSessionContextUsageMessage,
  reduceLatestSessionContextUsageMessage,
} from "./session-context-usage"

type TestMessage = {
  id: string
  time: { created: number; completed?: number }
  role: "user" | "assistant"
  includeInContext?: boolean
  contextUsage?: unknown
  tokens?: {
    input: number
    output: number
    reasoning: number
  }
  marker?: string
}

const assistant = (id: string, created: number, overrides: Partial<TestMessage> = {}): TestMessage => ({
  id,
  time: { created, completed: created + 1 },
  role: "assistant",
  tokens: { input: 0, output: 0, reasoning: 0 },
  ...overrides,
})

const user = (id: string, created: number): TestMessage => ({
  id,
  time: { created },
  role: "user",
})

describe("isSessionContextUsageMessage", () => {
  test("accepts assistant snapshots with structured or legacy usage", () => {
    expect(isSessionContextUsageMessage(assistant("structured", 1, { contextUsage: {} }))).toBe(true)
    expect(isSessionContextUsageMessage(assistant("input", 2, { tokens: { input: 1, output: 0, reasoning: 0 } }))).toBe(
      true,
    )
    expect(
      isSessionContextUsageMessage(assistant("output", 3, { tokens: { input: 0, output: 1, reasoning: 0 } })),
    ).toBe(true)
    expect(
      isSessionContextUsageMessage(assistant("reasoning", 4, { tokens: { input: 0, output: 0, reasoning: 1 } })),
    ).toBe(true)
  })

  test("rejects users, excluded assistants, and zero-usage assistants", () => {
    expect(isSessionContextUsageMessage(user("user", 1))).toBe(false)
    expect(isSessionContextUsageMessage(assistant("excluded", 2, { includeInContext: false, contextUsage: {} }))).toBe(
      false,
    )
    expect(isSessionContextUsageMessage(assistant("unfinished", 3, { time: { created: 3 } }))).toBe(false)
    expect(isSessionContextUsageMessage(assistant("finished", 4))).toBe(false)
  })
})

describe("findLatestSessionContextUsageMessage", () => {
  test("finds the latest eligible assistant by creation time then id", () => {
    const latest = findLatestSessionContextUsageMessage([
      assistant("z", 2, { contextUsage: {}, marker: "tie winner" }),
      assistant("later-ineligible", 3),
      user("user", 4),
      assistant("a", 2, { tokens: { input: 2, output: 0, reasoning: 0 } }),
    ])

    expect(latest?.id).toBe("z")
    expect(latest?.marker).toBe("tie winner")
  })

  test("returns null for an authoritative page without eligible assistants", () => {
    expect(findLatestSessionContextUsageMessage([user("user", 1), assistant("zero", 2)])).toBeNull()
  })
})

describe("reduceLatestSessionContextUsageMessage", () => {
  test("advances independently of viewport state and ignores older or ineligible arrivals", () => {
    const current = assistant("current", 2, { contextUsage: {}, marker: "current" })
    const older = assistant("older", 1, { contextUsage: {} })
    const unfinished = assistant("unfinished", 3, { time: { created: 3 } })
    const newer = assistant("newer", 4, { tokens: { input: 5, output: 0, reasoning: 0 } })

    expect(reduceLatestSessionContextUsageMessage(current, older)).toBe(current)
    expect(reduceLatestSessionContextUsageMessage(current, unfinished)).toBe(current)
    expect(reduceLatestSessionContextUsageMessage(current, newer)).toBe(newer)
    expect(reduceLatestSessionContextUsageMessage(null, newer)).toBe(newer)
    expect(reduceLatestSessionContextUsageMessage(undefined, newer)).toBe(newer)
  })

  test("replaces the same message snapshot when usage is reconciled", () => {
    const current = assistant("same", 2, { contextUsage: {}, marker: "old" })
    const updated = assistant("same", 2, { contextUsage: { total: 4 }, marker: "new" })

    expect(reduceLatestSessionContextUsageMessage(current, updated)?.marker).toBe("new")
  })
})

describe("invalidateLatestSessionContextUsageMessage", () => {
  test("invalidates only removal of the projected message", () => {
    const current = assistant("current", 2, { contextUsage: {} })

    expect(invalidateLatestSessionContextUsageMessage(current, "other")).toBe(current)
    expect(invalidateLatestSessionContextUsageMessage(current, "current")).toBeUndefined()
    expect(invalidateLatestSessionContextUsageMessage(null, "current")).toBeNull()
  })
})
