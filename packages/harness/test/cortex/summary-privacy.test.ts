import { expect, test } from "bun:test"
import { CortexDelegationInfo, CortexDelegationSummary } from "../../src/session/types"

test("Cortex summaries exclude exact continuation inputs and transfer authority", () => {
  const info = CortexDelegationInfo.parse({
    taskID: "task-private",
    parentSessionID: "parent-private",
    parentMessageID: "message-private",
    description: "Public task description",
    agent: "general",
    status: "running",
    startedAt: 1,
    rootID: "root-private",
    repairTurns: 2,
    pendingInput: { kind: "repair", text: "private exact repair input" },
    transfer: {
      version: 1,
      handoffID: "transfer-private",
      rootSessionID: "root-session-private",
      frozenAt: 2,
      priorStatus: "running",
      admitted: true,
    },
  })
  const summary = CortexDelegationSummary.parse(info)
  expect(summary.taskID).toBe(info.taskID)
  expect(summary.status).toBe("running")
  for (const field of ["rootID", "repairTurns", "pendingInput", "transfer"])
    expect(Object.hasOwn(summary, field)).toBeFalse()
  expect(JSON.stringify(summary)).not.toContain("private exact repair input")
  expect(JSON.stringify(summary)).not.toContain("transfer-private")
})
