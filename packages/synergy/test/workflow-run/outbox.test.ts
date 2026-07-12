import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { CharterStore } from "../../src/workflow-run/charter-store"
import { WorkflowEffects } from "../../src/workflow-run/effects"
import { WorkflowMachine } from "../../src/workflow-run/machine"
import { WorkflowRunStore } from "../../src/workflow-run/store"
import { WorkflowTypes } from "../../src/workflow-run/types"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

function charterWithEffect(): WorkflowTypes.Charter {
  return WorkflowTypes.Charter.parse({
    id: "cht_outbox",
    version: 1,
    name: "Outbox",
    entityType: "issue",
    entityInitialState: "queued",
    states: ["queued", "working", "done", WorkflowTypes.BLOCKED_STATE],
    terminalStates: ["done"],
    seats: [{ name: "worker", agent: "synergy", charterPrompt: "work", pool: 1, worktree: "none" }],
    transitions: [
      {
        id: "start",
        from: "queued",
        to: "working",
        trigger: { kind: "event" },
        guards: [],
        effects: [{ name: "set_binding", args: { key: "mark", value: "yes" } }],
      },
    ],
    gates: [],
    budget: { maxModelCalls: 0 },
    time: { created: Date.now() },
  })
}

describe("WorkflowEffects outbox", () => {
  test("successful transition drains pendingEffects and records effect_executed", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const charter = charterWithEffect()
      await CharterStore.put(scopeID, charter)
      const run = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: charter.id, version: 1 },
        title: "R",
        bossSessionID: "ses_boss",
        seats: [{ seat: "worker", instance: 0, status: "idle", sessionID: "ses_worker", lastEntityIDs: [] }],
        maxModelCalls: 0,
      })
      const now = Date.now()
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.entities.push({
          id: "wfe_1",
          runID: run.id,
          title: "E",
          state: "queued",
          bindings: {},
          submissions: [],
          time: { created: now, updated: now, stateEntered: now },
        })
      })

      await WorkflowMachine.evaluateEventTransitions(scopeID, run.id, "wfe_1")
      const after = await WorkflowRunStore.get(scopeID, run.id)
      expect(after.entities[0]?.state).toBe("working")
      expect(after.entities[0]?.bindings.mark).toBe("yes")
      expect(after.pendingEffects ?? []).toHaveLength(0)
      const events = await WorkflowRunStore.listEvents(scopeID, run.id)
      expect(events.some((e) => e.kind === "effect_executed" && e.message === "set_binding")).toBe(true)
    })
  })

  test("runPending skips already-executed effects", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const charter = charterWithEffect()
      await CharterStore.put(scopeID, charter)
      const run = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: charter.id, version: 1 },
        title: "R",
        bossSessionID: "ses_boss",
        seats: [],
        maxModelCalls: 0,
      })
      const now = Date.now()
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.entities.push({
          id: "wfe_1",
          runID: run.id,
          title: "E",
          state: "working",
          bindings: { mark: "yes" },
          submissions: [],
          time: { created: now, updated: now, stateEntered: now },
        })
        draft.pendingEffects = [
          {
            id: "pending_1",
            transitionEventID: "evt_1",
            transitionID: "start",
            entityID: "wfe_1",
            effects: [{ name: "set_binding", args: { key: "mark", value: "again" } }],
            nextIndex: 0,
          },
        ]
      })
      await WorkflowRunStore.appendEvent(scopeID, run, {
        kind: "effect_executed",
        entityID: "wfe_1",
        data: { effectKey: "evt_1:0" },
      })

      await WorkflowEffects.runPending(
        {
          scopeID,
          runID: run.id,
          entityID: "wfe_1",
          charter,
          transitionID: "start",
          transitionEventID: "evt_1",
        },
        "pending_1",
      )
      const after = await WorkflowRunStore.get(scopeID, run.id)
      // Skipped via effectAlreadyExecuted, so binding stays the original value.
      expect(after.entities[0]?.bindings.mark).toBe("yes")
      expect(after.pendingEffects ?? []).toHaveLength(0)
    })
  })
})
