import { expect, test } from "bun:test"
import { createBuiltinInternalAgents } from "../../src/agent/builtin-internal"

test("removes background tool summaries while retaining title and compaction agents", () => {
  const agents = createBuiltinInternalAgents({ defaults: [], user: [], role: () => undefined, evolutionActive: false })
  expect(agents["activity-summary"]).toBeUndefined()
  expect(agents.title).toBeDefined()
  expect(agents.summary).toBeDefined()
  expect(agents.compaction).toBeDefined()
})
