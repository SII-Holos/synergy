import { expect, test } from "bun:test"
import { createWorkspaceRevealPolicy } from "../../../src/context/workbench/reveal-policy"

test("a long task cannot notify again when its bounded output window is replayed", () => {
  const policy = createWorkspaceRevealPolicy(0)
  const outputs = Array.from({ length: 80 }, (_, index) => ({
    sessionID: "current",
    currentSessionID: "current",
    key: `resource-${index}`,
    completedAt: index + 1,
    busy: false,
    overlay: false,
  }))
  expect(outputs.map((output) => policy.request(output)).filter((action) => action === "reveal")).toHaveLength(1)
  expect(outputs.map((output) => policy.request(output))).toEqual(outputs.map(() => "ignore"))
  expect(policy.request({ ...outputs[79]!, key: "new-resource", completedAt: 81 })).toBe("notify")
})

test("only the first live output of the visible task may reveal the workspace", () => {
  const policy = createWorkspaceRevealPolicy(100)
  const output = {
    sessionID: "one",
    currentSessionID: "one",
    key: "resource",
    completedAt: 101,
    busy: false,
    overlay: false,
  }
  expect(policy.request({ ...output, sessionID: "background" })).toBe("ignore")
  expect(policy.request({ ...output, completedAt: 99 })).toBe("ignore")
  expect(policy.request(output)).toBe("reveal")
  expect(policy.request(output)).toBe("ignore")
  expect(policy.request({ ...output, key: "second" })).toBe("notify")
})

test("manual choice, editing and narrow modal layouts turn automatic opens into notices", () => {
  const policy = createWorkspaceRevealPolicy(100)
  policy.interact("one")
  const output = {
    sessionID: "one",
    currentSessionID: "one",
    key: "resource",
    completedAt: 101,
    busy: false,
    overlay: false,
  }
  expect(policy.request(output)).toBe("notify")
  expect(policy.request({ ...output, sessionID: "two", currentSessionID: "two", busy: true })).toBe("notify")
  expect(policy.request({ ...output, sessionID: "three", currentSessionID: "three", overlay: true })).toBe("notify")
  expect(policy.request({ ...output, sessionID: "two", currentSessionID: "two", key: "next" })).toBe("notify")
})

test("refresh preserves manual choices and the one-output allowance", () => {
  const states = new Map<string, { interacted?: boolean; consumed?: boolean }>()
  const storage = {
    read: (id: string) => states.get(id),
    write: (id: string, value: { interacted?: boolean; consumed?: boolean }) => {
      states.set(id, value)
    },
  }
  const output = {
    sessionID: "one",
    currentSessionID: "one",
    key: "first",
    completedAt: 101,
    busy: false,
    overlay: false,
  }
  const initial = createWorkspaceRevealPolicy(100, storage)
  expect(initial.request(output)).toBe("reveal")
  initial.interact("two")
  const restored = createWorkspaceRevealPolicy(102, storage)
  expect(restored.request({ ...output, key: "later", completedAt: 103 })).toBe("notify")
  expect(restored.request({ ...output, sessionID: "two", currentSessionID: "two", completedAt: 103 })).toBe("notify")
})
