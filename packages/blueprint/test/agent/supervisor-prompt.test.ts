import { expect, test } from "bun:test"
import { buildSupervisorPrompt } from "../../src/prompts/supervisor/builder"

test("review keeps independent acceptance and reuses valid evidence", () => {
  const prompt = buildSupervisorPrompt([])
  expect(prompt).toContain("Verify every required outcome")
  expect(prompt).toContain("Missing required verification is blocking")
  expect(prompt).toContain("optional improvements")
  expect(prompt).toContain("reuse the evidence")
  expect(prompt).toContain("blueprint_loop_approve")
  expect(prompt).toContain("blueprint_loop_reject")
})
