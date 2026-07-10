import { describe, expect, test } from "bun:test"
import { WorkflowHandoff } from "../../src/workflow-run/handoff"
import { WorkflowTypes } from "../../src/workflow-run/types"

function entity(overrides: Partial<WorkflowTypes.Entity> = {}): WorkflowTypes.Entity {
  const now = Date.now()
  return {
    id: "wfe_1",
    runID: "wfr_1",
    title: "Add max/ultra effort variants",
    description: "1. Update transform.ts\n2. Update OPENAI_EFFORTS\n3. Azure path\n4. Frontend\n5. Tests",
    state: "executing",
    bindings: {},
    submissions: [],
    time: { created: now, updated: now, stateEntered: now },
    ...overrides,
  }
}

function handoff(overrides: Partial<WorkflowHandoff.Info> = {}): WorkflowHandoff.Info {
  return {
    id: "wfh_1",
    runID: "wfr_1",
    entityID: "wfe_1",
    toSeat: { seat: "executor", instance: 0 },
    task: "Implement a fix for this issue in your worktree and commit it.",
    acceptance: ["Change is committed"],
    contextRefs: [],
    expectedSubmission: "deliverable",
    ...overrides,
  }
}

describe("WorkflowHandoff.render", () => {
  test("includes the entity description (the Boss's analysis) — not just the generic task", () => {
    const text = WorkflowHandoff.render(handoff(), entity())
    expect(text).toContain("Entity details:")
    expect(text).toContain("Update transform.ts")
    expect(text).toContain("OPENAI_EFFORTS")
    expect(text).toContain("workflow_submit")
  })

  test("omits the details section when there is no description", () => {
    const text = WorkflowHandoff.render(handoff(), entity({ description: undefined }))
    expect(text).not.toContain("Entity details:")
    expect(text).toContain("Task:")
  })
})
