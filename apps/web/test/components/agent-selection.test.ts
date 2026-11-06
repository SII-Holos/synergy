import { expect, test } from "bun:test"
import { defaultPrimaryAgent } from "../../src/components/agent-selection"
import { TEST_AGENT_NAME, SECONDARY_TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"

test("default selection respects the configured visible primary and server ordering", () => {
  const agents = [
    { name: TEST_AGENT_NAME, mode: "primary" as const },
    { name: SECONDARY_TEST_AGENT_NAME, mode: "primary" as const },
  ]
  expect(defaultPrimaryAgent(SECONDARY_TEST_AGENT_NAME, agents)).toBe(SECONDARY_TEST_AGENT_NAME)
  expect(defaultPrimaryAgent("missing", agents)).toBe(TEST_AGENT_NAME)
  expect(defaultPrimaryAgent(undefined, agents)).toBe(TEST_AGENT_NAME)
  expect(defaultPrimaryAgent(TEST_AGENT_NAME, [{ ...agents[0], hidden: true }, agents[1]])).toBe(
    SECONDARY_TEST_AGENT_NAME,
  )
  expect(defaultPrimaryAgent(TEST_AGENT_NAME, [{ ...agents[0], mode: "subagent" }])).toBeUndefined()
  expect(defaultPrimaryAgent(undefined, [])).toBeUndefined()
})
