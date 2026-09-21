import { expect, test } from "bun:test"
import { buildSynergyMaxPrompt } from "../../src/agent/prompt/synergy-max/builder"

test("max retains specialist selection context until catalog changes pass task evaluation", () => {
  const description = "Distinctive specialist selection context"
  const prompt = buildSynergyMaxPrompt([{ name: "implementation-engineer", description, mode: "subagent" }])
  expect(prompt).toContain(description)
  expect(prompt).toContain("task")
  expect(prompt).toContain("implementation-engineer")
})
