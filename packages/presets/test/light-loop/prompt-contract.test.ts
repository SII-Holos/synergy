import { TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { describe, expect, test } from "bun:test"
import { WorkflowUserWrapper } from "@ericsanchezok/synergy-harness/test/internal/session/workflow-user-wrapper"
// Product domains register workflow contributions via the L4 manifest
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("lightloop user-message wrapper contract", () => {
  test("primary and custom projections preserve the user request without repeating workflow instructions", () =>
    runtime.run(() => {
      for (const agent of [TEST_AGENT_NAME, ...Object.values(PrimaryAgentIdentity.names)]) {
        const wrapper = WorkflowUserWrapper.build(agent, "lightloop", "ship the importer")!
        expect(wrapper).toBe("ship the importer")
      }
    }))

  test("empty request normalizes to the sentinel", () =>
    runtime.run(() => {
      expect(WorkflowUserWrapper.build(PrimaryAgentIdentity.names.general, "lightloop", "   ")).toContain(
        "(empty request)",
      )
    }))
})

afterRuntimeTests(() => runtime.close())
