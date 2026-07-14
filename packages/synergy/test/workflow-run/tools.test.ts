import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { WorkflowBlockTool } from "../../src/tool/workflow-block"
import { WorkflowRunCreateTool } from "../../src/tool/workflow-run-create"
import { WorkflowToolShared } from "../../src/tool/workflow-shared"
import { WorkflowSubmitTool } from "../../src/tool/workflow-submit"
import { CharterStore } from "../../src/workflow-run/charter-store"
import { WorkflowRunStore } from "../../src/workflow-run/store"
import { WorkflowTypes } from "../../src/workflow-run/types"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

function toolContext(sessionID: string) {
  return {
    sessionID,
    messageID: "msg_test",
    callID: "call_test",
    agent: "synergy",
    abort: AbortSignal.any([]),
    metadata: () => undefined,
    ask: async () => undefined,
  }
}

async function seedSeatRun() {
  const scopeID = ScopeContext.current.scope.id
  const boss = await Session.create({})
  const seat = await Session.create({ parentID: boss.id })
  const charter = WorkflowTypes.Charter.parse({
    id: "cht_tool_test",
    version: 1,
    name: "Tool test",
    entityType: "issue",
    entityInitialState: "working",
    states: ["working", "done", WorkflowTypes.BLOCKED_STATE],
    terminalStates: ["done"],
    seats: [{ name: "worker", agent: "synergy", charterPrompt: "work", pool: 1, worktree: "none" }],
    transitions: [
      {
        id: "finish",
        from: "working",
        to: "done",
        trigger: { kind: "intent", allowedSeats: ["worker"] },
        guards: [],
        effects: [],
      },
    ],
    gates: [],
    budget: { maxModelCalls: 0 },
    time: { created: Date.now() },
  })
  await CharterStore.put(scopeID, charter)
  const run = await WorkflowRunStore.create({
    scopeID,
    charterRef: { id: charter.id, version: charter.version },
    title: "Tool run",
    bossSessionID: boss.id,
    seats: [{ seat: "worker", instance: 0, status: "waiting", sessionID: seat.id, lastEntityIDs: [] }],
    maxModelCalls: 0,
  })
  const now = Date.now()
  const entity: WorkflowTypes.Entity = {
    id: "wfe_tool_entity",
    runID: run.id,
    title: "Tool entity",
    state: "working",
    bindings: { seatSessionID: seat.id },
    submissions: [],
    assignedSeat: { seat: "worker", instance: 0 },
    time: { created: now, updated: now, stateEntered: now },
  }
  await WorkflowRunStore.update(scopeID, run.id, (draft) => {
    draft.entities.push(entity)
    const binding = draft.seats[0]
    if (binding) binding.entityID = entity.id
  })
  await Session.update(seat.id, (draft) => {
    draft.workflowRun = { runID: run.id, role: "seat", seat: "worker", instance: 0 }
  })
  return { scopeID, boss, seat, run, entity }
}

describe("workflow-run seat tools", () => {
  test("workflow_run_create rejects invalid versions and budgets", async () => {
    const tool = await WorkflowRunCreateTool.init()
    for (const input of [
      { title: "Invalid", version: 0 },
      { title: "Invalid", version: 1.5 },
      { title: "Invalid", maxModelCalls: -1 },
      { title: "Invalid", maxModelCalls: 1.5 },
    ]) {
      expect(tool.parameters.safeParse(input).success).toBe(false)
    }
  })

  test("workflow_block cannot mutate an entity after the run is paused", async () => {
    await withScope(async () => {
      const { scopeID, seat, run, entity } = await seedSeatRun()
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.status = "paused"
      })

      const tool = await WorkflowBlockTool.init()
      await expect(tool.execute({ reason: "waiting" }, toolContext(seat.id))).rejects.toThrow(/active/)

      const unchanged = await WorkflowRunStore.get(scopeID, run.id)
      expect(unchanged.entities.find((item) => item.id === entity.id)?.state).toBe("working")
    })
  })

  test("workflow_submit cannot record a result after the run is cancelled", async () => {
    await withScope(async () => {
      const { scopeID, seat, run, entity } = await seedSeatRun()
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.status = "cancelled"
      })

      const tool = await WorkflowSubmitTool.init()
      await expect(tool.execute({ kind: "note_ref", summary: "stale result" }, toolContext(seat.id))).rejects.toThrow(
        /active/,
      )

      const unchanged = await WorkflowRunStore.get(scopeID, run.id)
      expect(unchanged.entities.find((item) => item.id === entity.id)?.submissions).toHaveLength(0)
    })
  })

  test("the shared seat mutation fence rejects ownership that changed after requireSeat", async () => {
    await withScope(async () => {
      const { scopeID, seat, run, entity } = await seedSeatRun()
      const context = await WorkflowToolShared.requireSeat(seat.id)
      if (!context.entity) throw new Error("missing assigned entity")
      const now = Date.now()
      const replacement: WorkflowTypes.Entity = {
        id: "wfe_tool_replacement",
        runID: run.id,
        title: "Replacement",
        state: "working",
        bindings: { seatSessionID: seat.id },
        submissions: [],
        assignedSeat: { seat: "worker", instance: 0 },
        time: { created: now, updated: now, stateEntered: now },
      }
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.entities.push(replacement)
        const binding = draft.seats[0]
        if (binding) binding.entityID = replacement.id
      })

      await expect(
        WorkflowToolShared.updateActiveSeatEntity({
          sessionID: seat.id,
          context: { ...context, entity: context.entity },
          edit(draftEntity) {
            draftEntity.state = WorkflowTypes.BLOCKED_STATE
          },
        }),
      ).rejects.toThrow(/WorkflowNotAuthorized/)

      const unchanged = await WorkflowRunStore.get(scopeID, run.id)
      expect(unchanged.entities.find((item) => item.id === entity.id)?.state).toBe("working")
    })
  })

  test("workflow_block delivers a canonical system-origin Boss notice", async () => {
    await withScope(async () => {
      const { boss, seat, run, entity } = await seedSeatRun()
      const tool = await WorkflowBlockTool.init()
      await tool.execute({ reason: "needs credentials" }, toolContext(seat.id))

      const notices = await SessionInbox.list(boss.id)
      expect(notices).toHaveLength(1)
      expect(notices[0]?.mode).toBe("steer")
      expect(notices[0]?.message?.origin).toEqual({ type: "system", detail: "workflow_boss_notice" })
      expect(notices[0]?.message?.metadata?.workflowRun).toEqual({ runID: run.id, entityID: entity.id })
      const part = notices[0]?.message?.parts[0]
      expect(part?.type).toBe("text")
      if (part?.type === "text") {
        expect(part.origin).toBe("system")
        expect(part.synthetic).toBeUndefined()
      }
    })
  })
})
