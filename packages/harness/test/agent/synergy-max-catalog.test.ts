import { expect, test } from "bun:test"
import { buildSynergyMaxPrompt } from "../../src/agent/prompt/synergy-max/builder"

test("max keeps delegation policy without duplicating full specialist descriptions", () => {
  const description = "Distinctive specialist description that belongs only in the task catalog"
  const prompt = buildSynergyMaxPrompt([{ name: "implementation-engineer", description, mode: "subagent" }])
  expect(prompt).not.toContain(description)
  expect(prompt).toContain("task")
  expect(prompt).toContain("implementation-engineer")
})
