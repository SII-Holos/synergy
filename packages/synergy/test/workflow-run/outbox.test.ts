import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { CharterStore } from "../../src/workflow-run/charter-store"
import { Cortex } from "../../src/cortex"
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

async function reopenReceiptGap(scopeID: string, runID: string, effectKey: string): Promise<void> {
  const receipt = (await WorkflowRunStore.listEvents(scopeID, runID)).find(
    (event) => event.kind === "effect_executed" && event.data?.effectKey === effectKey,
  )
  if (receipt) {
    await Storage.remove(StoragePath.workflowEvent(Identifier.asScopeID(scopeID), runID, receipt.id))
  }
  await WorkflowRunStore.update(scopeID, runID, (draft) => {
    delete draft.effectReceipts?.[effectKey]
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
      expect(Object.keys(after.effectReceipts ?? {})).toHaveLength(1)
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

  test("replaying a boss notification after a receipt gap does not duplicate the durable notice", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const boss = await Session.create({ scope: ScopeContext.current.scope, title: "Boss" })
      const charter = charterWithEffect()
      charter.transitions[0]!.effects = [{ name: "notify_boss", args: { message: "Review is ready." } }]
      await CharterStore.put(scopeID, charter)
      const run = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: charter.id, version: 1 },
        title: "R",
        bossSessionID: boss.id,
        seats: [],
        maxModelCalls: 0,
      })
      const now = Date.now()
      const pending = {
        id: "pending_notice",
        transitionEventID: "wfv_notice_transition",
        transitionID: "start",
        entityID: "wfe_1",
        effects: charter.transitions[0]!.effects,
        nextIndex: 0,
      }
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.entities.push({
          id: "wfe_1",
          runID: run.id,
          title: "E",
          state: "working",
          bindings: {},
          submissions: [],
          time: { created: now, updated: now, stateEntered: now },
        })
        draft.pendingEffects = [pending]
      })

      const context = {
        scopeID,
        runID: run.id,
        entityID: "wfe_1",
        charter,
        transitionID: "start",
        transitionEventID: pending.transitionEventID,
      }
      await WorkflowEffects.runPending(context, pending.id)
      await reopenReceiptGap(scopeID, run.id, `${pending.transitionEventID}:0`)
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.pendingEffects = [pending]
      })
      await WorkflowEffects.runPending(context, pending.id)

      const notices = (await SessionInbox.list(boss.id)).filter(
        (item) => item.message?.metadata?.workflowRun?.noticeID === "wfn_wfv_notice_transition_0",
      )
      expect(notices).toHaveLength(1)
    })
  })

  test("replaying an open-gate effect reuses the gate and its boss notice", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const boss = await Session.create({ scope: ScopeContext.current.scope, title: "Boss" })
      const charter = charterWithEffect()
      charter.gates = [{ name: "approval", title: "Approve", resolutions: ["merge", "rework"] }]
      charter.transitions[0]!.effects = [{ name: "open_gate", args: { gate: "approval" } }]
      await CharterStore.put(scopeID, charter)
      const run = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: charter.id, version: 1 },
        title: "R",
        bossSessionID: boss.id,
        seats: [],
        maxModelCalls: 0,
      })
      const now = Date.now()
      const pending = {
        id: "pending_gate",
        transitionEventID: "wfv_gate_transition",
        transitionID: "start",
        entityID: "wfe_1",
        effects: charter.transitions[0]!.effects,
        nextIndex: 0,
      }
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.entities.push({
          id: "wfe_1",
          runID: run.id,
          title: "E",
          state: "working",
          bindings: {},
          submissions: [],
          time: { created: now, updated: now, stateEntered: now },
        })
        draft.pendingEffects = [pending]
      })
      const context = {
        scopeID,
        runID: run.id,
        entityID: "wfe_1",
        charter,
        transitionID: "start",
        transitionEventID: pending.transitionEventID,
      }

      await WorkflowEffects.runPending(context, pending.id)
      await reopenReceiptGap(scopeID, run.id, `${pending.transitionEventID}:0`)
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.pendingEffects = [pending]
      })
      await WorkflowEffects.runPending(context, pending.id)

      const after = await WorkflowRunStore.get(scopeID, run.id)
      expect(after.gates.map((gate) => gate.id)).toEqual(["wfg_wfv_gate_transition_0"])
      const notices = (await SessionInbox.list(boss.id)).filter(
        (item) => item.message?.metadata?.workflowRun?.noticeID === "wfn_gate_wfv_gate_transition_0",
      )
      expect(notices).toHaveLength(1)
    })
  })

  test("spawn_contractor launches a bounded delegated subagent", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const boss = await Session.create({ scope: ScopeContext.current.scope, title: "Boss" })
      const charter = charterWithEffect()
      charter.transitions[0]!.effects = [
        { name: "spawn_contractor", args: { agent: "synergy", prompt: "Check the implementation." } },
      ]
      await CharterStore.put(scopeID, charter)
      const run = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: charter.id, version: charter.version },
        title: "R",
        bossSessionID: boss.id,
        seats: [],
        maxModelCalls: 0,
      })
      const now = Date.now()
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.entities.push({
          id: "wfe_contractor_role",
          runID: run.id,
          title: "E",
          state: "queued",
          bindings: {},
          submissions: [],
          time: { created: now, updated: now, stateEntered: now },
        })
      })

      await WorkflowMachine.evaluateEventTransitions(scopeID, run.id, "wfe_contractor_role")

      const contractor = (await Session.children(boss.id)).find(
        (child) => child.cortex?.owner?.kind === "workflow_run" && child.cortex.owner.runID === run.id,
      )
      expect(contractor?.cortex?.executionRole).toBe("delegated_subagent")
      expect(contractor?.permission).toContainEqual({ permission: "question", pattern: "*", action: "deny" })
      expect(contractor?.permission).toContainEqual({ permission: "task", pattern: "*", action: "deny" })

      if (contractor?.cortex?.taskID) await Cortex.cancel(contractor.cortex.taskID)
    })
  })
})
