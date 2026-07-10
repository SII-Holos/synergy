import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { WorkflowContinuationPolicy } from "../../src/workflow-run/policy"
import { WorkflowRunStore } from "../../src/workflow-run/store"
import { WorkflowTypes } from "../../src/workflow-run/types"
import type { Info as SessionInfo } from "../../src/session/types"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

function gateFor(sessionID: string, role: "boss" | "seat", seat?: string) {
  return {
    scopeID: ScopeContext.current.scope.id,
    sessionID,
    terminalMessageID: "msg_terminal",
    session: {
      id: sessionID,
      workflowRun: { runID: "", role, seat, instance: 0 },
    } as unknown as SessionInfo,
  }
}

async function seedRun(seatSessionID: string, entityState: string) {
  const scopeID = ScopeContext.current.scope.id
  const run = await WorkflowRunStore.create({
    scopeID,
    charterRef: { id: "cht_x", version: 1 },
    title: "R",
    bossSessionID: "ses_boss",
    seats: [
      {
        seat: "executor",
        instance: 0,
        status: "working",
        sessionID: seatSessionID,
        entityID: "wfe_1",
        lastEntityIDs: [],
      },
    ],
    maxModelCalls: 0,
  })
  const now = Date.now()
  const entity: WorkflowTypes.Entity = {
    id: "wfe_1",
    runID: run.id,
    title: "E",
    state: entityState,
    bindings: { seatSessionID },
    submissions: [],
    assignedSeat: { seat: "executor", instance: 0 },
    time: { created: now, updated: now, stateEntered: now },
  }
  await WorkflowRunStore.update(scopeID, run.id, (draft) => {
    draft.entities.push(entity)
  })
  return run
}

describe("WorkflowContinuationPolicy", () => {
  test("ignores non-seat (boss) sessions", async () => {
    await withScope(async () => {
      const handled = await WorkflowContinuationPolicy.handle(gateFor("ses_boss", "boss"))
      expect(handled).toBe(false)
    })
  })

  test("nudges a seat that has an assigned, non-blocked entity", async () => {
    await withScope(async () => {
      const run = await seedRun("ses_worker", "executing")
      const gate = { ...gateFor("ses_worker", "seat", "executor") }
      ;(gate.session as any).workflowRun.runID = run.id
      const handled = await WorkflowContinuationPolicy.handle(gate)
      expect(handled).toBe(true) // delivered a continuation nudge
    })
  })

  test("does not nudge a seat whose entity is blocked", async () => {
    await withScope(async () => {
      const run = await seedRun("ses_worker", WorkflowTypes.BLOCKED_STATE)
      const gate = { ...gateFor("ses_worker", "seat", "executor") }
      ;(gate.session as any).workflowRun.runID = run.id
      const handled = await WorkflowContinuationPolicy.handle(gate)
      expect(handled).toBe(false)
    })
  })
})
