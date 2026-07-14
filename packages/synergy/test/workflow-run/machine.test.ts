import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { CharterStore } from "../../src/workflow-run/charter-store"
import { WorkflowRunStore } from "../../src/workflow-run/store"
import { WorkflowMachine } from "../../src/workflow-run/machine"
import { WorkflowGuards } from "../../src/workflow-run/guards"
import { WorkflowTypes } from "../../src/workflow-run/types"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

/** A charter with no session-creating effects, to isolate machine behaviour. */
function testCharter(overrides: Partial<WorkflowTypes.Charter> = {}): WorkflowTypes.Charter {
  return WorkflowTypes.Charter.parse({
    id: "cht_test",
    version: 1,
    name: "Test",
    entityType: "issue",
    entityInitialState: "queued",
    states: ["queued", "working", "review", "done", WorkflowTypes.BLOCKED_STATE],
    terminalStates: ["done"],
    seats: [{ name: "worker", agent: "synergy", charterPrompt: "work", pool: 1, worktree: "none" }],
    transitions: [
      { id: "start", from: "queued", to: "working", trigger: { kind: "event" }, guards: [], effects: [] },
      {
        id: "submit",
        from: "working",
        to: "review",
        trigger: { kind: "intent", allowedSeats: ["worker"] },
        guards: [],
        effects: [],
      },
      {
        id: "approve",
        from: "review",
        to: "done",
        trigger: { kind: "intent", allowedSeats: ["worker"] },
        guards: [{ name: "submission_recorded", args: { kind: "review_verdict", verdict: "passed", fresh: "true" } }],
        effects: [],
      },
    ],
    gates: [],
    budget: { maxModelCalls: 0 },
    time: { created: Date.now() },
    ...overrides,
  })
}

async function seedRun(charter: WorkflowTypes.Charter, bossSessionID = "ses_boss") {
  const scopeID = ScopeContext.current.scope.id
  await CharterStore.put(scopeID, charter)
  const run = await WorkflowRunStore.create({
    scopeID,
    charterRef: { id: charter.id, version: charter.version },
    title: "Run",
    bossSessionID,
    seats: [{ seat: "worker", instance: 0, status: "idle", sessionID: "ses_worker", lastEntityIDs: [] }],
    maxModelCalls: 0,
  })
  return { scopeID, run }
}

async function addEntity(scopeID: string, runID: string, state: string) {
  const now = Date.now()
  const entity: WorkflowTypes.Entity = {
    id: `wfe_${Math.random().toString(36).slice(2, 8)}`,
    runID,
    title: "E",
    state,
    bindings: { seatSessionID: "ses_worker" },
    submissions: [],
    assignedSeat: { seat: "worker", instance: 0 },
    time: { created: now, updated: now, stateEntered: now },
  }
  await WorkflowRunStore.update(scopeID, runID, (draft) => {
    draft.entities.push(entity)
    const seat = draft.seats.find((binding) => binding.sessionID === "ses_worker")
    if (seat) seat.entityID = entity.id
  })
  return entity
}

describe("WorkflowMachine", () => {
  test("event transition fires automatically when guards pass", async () => {
    await withScope(async () => {
      const { scopeID, run } = await seedRun(testCharter())
      const entity = await addEntity(scopeID, run.id, "queued")
      await WorkflowMachine.evaluateEventTransitions(scopeID, run.id, entity.id)
      const updated = await WorkflowRunStore.get(scopeID, run.id)
      expect(updated.entities[0].state).toBe("working")
    })
  })

  test("event transition blocks by default when a non-retryable guard fails", async () => {
    await withScope(async () => {
      const charter = testCharter({
        transitions: [
          {
            id: "guarded_start",
            from: "queued",
            to: "working",
            trigger: { kind: "event" },
            guards: [{ name: "submission_recorded", args: { kind: "deliverable" } }],
            effects: [],
          },
        ],
      })
      const { scopeID, run } = await seedRun(charter)
      const entity = await addEntity(scopeID, run.id, "queued")

      await WorkflowMachine.evaluateEventTransitions(scopeID, run.id, entity.id)

      const updated = await WorkflowRunStore.get(scopeID, run.id)
      expect(updated.entities[0]?.state).toBe(WorkflowTypes.BLOCKED_STATE)
      expect(updated.entities[0]?.blockedReason).toContain("submission_recorded")
      const events = await WorkflowRunStore.listEvents(scopeID, run.id)
      expect(events.some((event) => event.kind === "guard_failed" && event.transitionID === "guarded_start")).toBe(true)
      expect(events.some((event) => event.kind === "entity_blocked" && event.entityID === entity.id)).toBe(true)
    })
  })

  test("event transition with blockOnGuardFail false waits and can be retried", async () => {
    await withScope(async () => {
      const charter = testCharter({
        transitions: [
          {
            id: "guarded_start",
            from: "queued",
            to: "working",
            trigger: { kind: "event" },
            guards: [{ name: "submission_recorded", args: { kind: "deliverable" } }],
            effects: [],
            blockOnGuardFail: false,
          },
        ],
      })
      const { scopeID, run } = await seedRun(charter)
      const entity = await addEntity(scopeID, run.id, "queued")

      await WorkflowMachine.evaluateEventTransitions(scopeID, run.id, entity.id)
      expect((await WorkflowRunStore.get(scopeID, run.id)).entities[0]?.state).toBe("queued")

      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        const current = draft.entities.find((candidate) => candidate.id === entity.id)
        current?.submissions.push({
          id: "sub_deliverable",
          kind: "deliverable",
          seat: "worker",
          sessionID: "ses_worker",
          summary: "ready",
          refs: [],
          time: Date.now(),
        })
      })
      await WorkflowMachine.evaluateEventTransitions(scopeID, run.id, entity.id)

      expect((await WorkflowRunStore.get(scopeID, run.id)).entities[0]?.state).toBe("working")
    })
  })

  test("retryable event guard waits without blocking and advances on redrive", async () => {
    await withScope(async () => {
      let ready = false
      WorkflowGuards.register("test_retryable_event_guard", () =>
        ready ? { ok: true } : { ok: false, reason: "resource unavailable", retryable: true },
      )
      const charter = testCharter({
        transitions: [
          {
            id: "retryable_start",
            from: "queued",
            to: "working",
            trigger: { kind: "event" },
            guards: [{ name: "test_retryable_event_guard", args: {} }],
            effects: [],
          },
        ],
      })
      const { scopeID, run } = await seedRun(charter)
      const entity = await addEntity(scopeID, run.id, "queued")

      await WorkflowMachine.evaluateEventTransitions(scopeID, run.id, entity.id)
      expect((await WorkflowRunStore.get(scopeID, run.id)).entities[0]?.state).toBe("queued")

      ready = true
      await WorkflowMachine.redrivePending(scopeID, run.id)

      expect((await WorkflowRunStore.get(scopeID, run.id)).entities[0]?.state).toBe("working")
      const events = await WorkflowRunStore.listEvents(scopeID, run.id)
      expect(events.some((event) => event.kind === "entity_blocked" && event.entityID === entity.id)).toBe(false)
    })
  })

  test("intent from an unauthorized seat is rejected", async () => {
    await withScope(async () => {
      const { scopeID, run } = await seedRun(testCharter())
      const entity = await addEntity(scopeID, run.id, "working")
      const result = await WorkflowMachine.submitIntent({
        scopeID,
        runID: run.id,
        entityID: entity.id,
        transitionID: "submit",
        actorSessionID: "ses_intruder",
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain("not a seat")
    })
  })

  test("concurrent intents on the same entity only commit one transition", async () => {
    await withScope(async () => {
      const { scopeID, run } = await seedRun(testCharter())
      const entity = await addEntity(scopeID, run.id, "working")
      const [first, second] = await Promise.all([
        WorkflowMachine.submitIntent({
          scopeID,
          runID: run.id,
          entityID: entity.id,
          transitionID: "submit",
          actorSessionID: "ses_worker",
        }),
        WorkflowMachine.submitIntent({
          scopeID,
          runID: run.id,
          entityID: entity.id,
          transitionID: "submit",
          actorSessionID: "ses_worker",
        }),
      ])
      const outcomes = [first, second]
      expect(outcomes.filter((item) => item.ok)).toHaveLength(1)
      expect(outcomes.filter((item) => !item.ok)).toHaveLength(1)
      const updated = await WorkflowRunStore.get(scopeID, run.id)
      expect(updated.entities[0]?.state).toBe("review")
    })
  })

  test("authorized intent advances the entity", async () => {
    await withScope(async () => {
      const { scopeID, run } = await seedRun(testCharter())
      const entity = await addEntity(scopeID, run.id, "working")
      const result = await WorkflowMachine.submitIntent({
        scopeID,
        runID: run.id,
        entityID: entity.id,
        transitionID: "submit",
        actorSessionID: "ses_worker",
      })
      expect(result.ok).toBe(true)
      const updated = await WorkflowRunStore.get(scopeID, run.id)
      expect(updated.entities[0].state).toBe("review")
    })
  })

  test("intent whose guard fails is rejected and logs guard_failed", async () => {
    await withScope(async () => {
      const { scopeID, run } = await seedRun(testCharter())
      const entity = await addEntity(scopeID, run.id, "review")
      const result = await WorkflowMachine.submitIntent({
        scopeID,
        runID: run.id,
        entityID: entity.id,
        transitionID: "approve", // guard requires a fresh passed review_verdict submission
        actorSessionID: "ses_worker",
      })
      expect(result.ok).toBe(false)
      const events = await WorkflowRunStore.listEvents(scopeID, run.id)
      expect(events.some((e) => e.kind === "guard_failed")).toBe(true)
      const updated = await WorkflowRunStore.get(scopeID, run.id)
      expect(updated.entities[0].state).toBe("review") // not advanced
    })
  })

  test("submission attached to an intent satisfies its own fresh guard", async () => {
    await withScope(async () => {
      const { scopeID, run } = await seedRun(testCharter())
      const entity = await addEntity(scopeID, run.id, "review")
      const result = await WorkflowMachine.submitIntent({
        scopeID,
        runID: run.id,
        entityID: entity.id,
        transitionID: "approve",
        actorSessionID: "ses_worker",
        submission: {
          id: "s1",
          kind: "review_verdict",
          seat: "worker",
          sessionID: "ses_worker",
          verdict: "passed",
          summary: "lgtm",
          refs: [],
          time: Date.now(),
        },
      })
      expect(result.ok).toBe(true)
      const updated = await WorkflowRunStore.get(scopeID, run.id)
      expect(updated.entities[0].state).toBe("done")
    })
  })

  test("intent commit rechecks seat ownership after an asynchronous guard", async () => {
    await withScope(async () => {
      let notifyGuardEntered: () => void = () => undefined
      const guardEntered = new Promise<void>((resolve) => {
        notifyGuardEntered = resolve
      })
      let releaseGuard: () => void = () => undefined
      const guardRelease = new Promise<void>((resolve) => {
        releaseGuard = resolve
      })
      WorkflowGuards.register("test_wait_for_reassignment", async () => {
        notifyGuardEntered()
        await guardRelease
        return { ok: true }
      })
      const charter = testCharter()
      const submit = charter.transitions.find((transition) => transition.id === "submit")
      if (!submit) throw new Error("missing submit transition")
      submit.guards.push({ name: "test_wait_for_reassignment", args: {} })
      const { scopeID, run } = await seedRun(charter)
      const entity = await addEntity(scopeID, run.id, "working")
      const now = Date.now()
      const replacement: WorkflowTypes.Entity = {
        id: "wfe_replacement",
        runID: run.id,
        title: "Replacement",
        state: "working",
        bindings: { seatSessionID: "ses_worker" },
        submissions: [],
        assignedSeat: { seat: "worker", instance: 0 },
        time: { created: now, updated: now, stateEntered: now },
      }
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.entities.push(replacement)
      })

      const pending = WorkflowMachine.submitIntent({
        scopeID,
        runID: run.id,
        entityID: entity.id,
        transitionID: "submit",
        actorSessionID: "ses_worker",
      })
      await guardEntered
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        const seat = draft.seats.find((binding) => binding.sessionID === "ses_worker")
        if (seat) seat.entityID = replacement.id
      })
      releaseGuard()

      const result = await pending
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain("does not own")
      const unchanged = await WorkflowRunStore.get(scopeID, run.id)
      expect(unchanged.entities.find((candidate) => candidate.id === entity.id)?.state).toBe("working")
    })
  })

  test("effect failure blocks the entity and is not silent", async () => {
    await withScope(async () => {
      // assign_entity with no 'seat' arg throws → the transition's effect fails.
      const charter = testCharter({
        transitions: [
          {
            id: "start",
            from: "queued",
            to: "working",
            trigger: { kind: "event" },
            guards: [],
            effects: [{ name: "assign_entity", args: {} }],
          },
        ],
      })
      const boss = await Session.create({})
      const { scopeID, run } = await seedRun(charter, boss.id)
      const entity = await addEntity(scopeID, run.id, "queued")
      await WorkflowMachine.evaluateEventTransitions(scopeID, run.id, entity.id)
      const updated = await WorkflowRunStore.get(scopeID, run.id)
      expect(updated.entities[0].state).toBe(WorkflowTypes.BLOCKED_STATE)
      const events = await WorkflowRunStore.listEvents(scopeID, run.id)
      expect(events.some((e) => e.kind === "effect_failed")).toBe(true)
      expect(events.some((e) => e.kind === "entity_blocked")).toBe(true)
    })
  })
})

describe("WorkflowMachine gates", () => {
  function gateCharter(): WorkflowTypes.Charter {
    return testCharter({
      states: ["queued", "awaiting_merge", "merged", "rework", WorkflowTypes.BLOCKED_STATE],
      terminalStates: ["merged"],
      entityInitialState: "queued",
      transitions: [
        {
          id: "merge",
          from: "awaiting_merge",
          to: "merged",
          trigger: { kind: "gate", gate: "final_merge" },
          guards: [{ name: "gate_resolved", args: { gate: "final_merge", accept: "merge" } }],
          effects: [],
        },
        {
          id: "reworkT",
          from: "awaiting_merge",
          to: "rework",
          trigger: { kind: "gate", gate: "final_merge" },
          guards: [{ name: "gate_resolved", args: { gate: "final_merge", accept: "rework" } }],
          effects: [],
        },
      ],
      gates: [{ name: "final_merge", title: "Merge?", resolutions: ["merge", "rework"] }],
    })
  }

  test("resolving a gate fires the matching gate transition", async () => {
    await withScope(async () => {
      const { scopeID, run } = await seedRun(gateCharter())
      const entity = await addEntity(scopeID, run.id, "awaiting_merge")
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.gates.push({
          id: "wfg_1",
          gate: "final_merge",
          entityID: entity.id,
          transitionID: "merge",
          status: "pending",
          time: { created: Date.now() },
        })
      })
      const beforeResolution = await WorkflowRunStore.get(scopeID, run.id)
      const updated = await WorkflowMachine.resolveGate({
        scopeID,
        runID: run.id,
        gateInstanceID: "wfg_1",
        resolution: "merge",
        resolvedBy: "human_ui",
      })
      expect(updated.entities[0].state).toBe("merged")
      expect(updated.gates[0].status).toBe("resolved")
      expect(updated.gates[0].resolvedBy).toBe("human_ui")
      expect(updated.revision).toBe(beforeResolution.revision + 1)
    })
  })

  test("a rework resolution routes the entity to the rework state", async () => {
    await withScope(async () => {
      const { scopeID, run } = await seedRun(gateCharter())
      const entity = await addEntity(scopeID, run.id, "awaiting_merge")
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.gates.push({
          id: "wfg_2",
          gate: "final_merge",
          entityID: entity.id,
          transitionID: "merge",
          status: "pending",
          time: { created: Date.now() },
        })
      })
      const updated = await WorkflowMachine.resolveGate({
        scopeID,
        runID: run.id,
        gateInstanceID: "wfg_2",
        resolution: "rework",
        resolvedBy: "boss_agent",
      })
      expect(updated.entities[0].state).toBe("rework")
    })
  })

  test("a terminal run rejects gate resolution without mutating the gate or entity", async () => {
    await withScope(async () => {
      const { scopeID, run } = await seedRun(gateCharter())
      const entity = await addEntity(scopeID, run.id, "awaiting_merge")
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.status = "cancelled"
        draft.time.completed = Date.now()
        draft.gates.push({
          id: "wfg_cancelled",
          gate: "final_merge",
          entityID: entity.id,
          transitionID: "merge",
          status: "pending",
          time: { created: Date.now() },
        })
      })

      await expect(
        WorkflowMachine.resolveGate({
          scopeID,
          runID: run.id,
          gateInstanceID: "wfg_cancelled",
          resolution: "merge",
          resolvedBy: "human_ui",
        }),
      ).rejects.toThrow(/WorkflowTransitionRejected/)

      const unchanged = await WorkflowRunStore.get(scopeID, run.id)
      expect(unchanged.gates[0]?.status).toBe("pending")
      expect(unchanged.entities[0]?.state).toBe("awaiting_merge")
    })
  })

  test("a valid resolution with no matching transition leaves the gate pending", async () => {
    await withScope(async () => {
      const charter = gateCharter()
      charter.transitions = charter.transitions.filter((transition) => transition.id === "merge")
      const { scopeID, run } = await seedRun(charter)
      const entity = await addEntity(scopeID, run.id, "awaiting_merge")
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.gates.push({
          id: "wfg_no_match",
          gate: "final_merge",
          entityID: entity.id,
          transitionID: "merge",
          status: "pending",
          time: { created: Date.now() },
        })
      })

      await expect(
        WorkflowMachine.resolveGate({
          scopeID,
          runID: run.id,
          gateInstanceID: "wfg_no_match",
          resolution: "rework",
          resolvedBy: "human_ui",
        }),
      ).rejects.toThrow(/WorkflowTransitionRejected/)

      const unchanged = await WorkflowRunStore.get(scopeID, run.id)
      expect(unchanged.gates[0]?.status).toBe("pending")
      expect(unchanged.entities[0]?.state).toBe("awaiting_merge")
      const events = await WorkflowRunStore.listEvents(scopeID, run.id)
      expect(events.some((event) => event.kind === "gate_resolved")).toBe(false)
    })
  })

  test("a matching gate transition whose guards fail leaves the gate pending", async () => {
    await withScope(async () => {
      const charter = gateCharter()
      const merge = charter.transitions.find((transition) => transition.id === "merge")
      if (!merge) throw new Error("missing merge transition")
      merge.guards.push({ name: "submission_recorded", args: { kind: "deliverable" } })
      merge.blockOnGuardFail = true
      const { scopeID, run } = await seedRun(charter)
      const entity = await addEntity(scopeID, run.id, "awaiting_merge")
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.gates.push({
          id: "wfg_guard_failed",
          gate: "final_merge",
          entityID: entity.id,
          transitionID: "merge",
          status: "pending",
          time: { created: Date.now() },
        })
      })

      await expect(
        WorkflowMachine.resolveGate({
          scopeID,
          runID: run.id,
          gateInstanceID: "wfg_guard_failed",
          resolution: "merge",
          resolvedBy: "boss_agent",
        }),
      ).rejects.toThrow(/WorkflowTransitionRejected/)

      const unchanged = await WorkflowRunStore.get(scopeID, run.id)
      expect(unchanged.gates[0]?.status).toBe("pending")
      expect(unchanged.entities[0]?.state).toBe("awaiting_merge")
    })
  })
})
