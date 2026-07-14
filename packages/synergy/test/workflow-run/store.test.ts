import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { WorkflowRunStore } from "../../src/workflow-run/store"
import { WorkflowTypes } from "../../src/workflow-run/types"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

async function makeRun() {
  const scopeID = ScopeContext.current.scope.id
  const run = await WorkflowRunStore.create({
    scopeID,
    charterRef: { id: "cht_x", version: 1 },
    title: "R",
    bossSessionID: "ses_boss",
    seats: [],
    maxModelCalls: 0,
  })
  return { scopeID, run }
}

describe("WorkflowRunStore", () => {
  test("rejects negative and fractional model-call budgets", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      for (const maxModelCalls of [-1, 1.5]) {
        await expect(
          WorkflowRunStore.create({
            scopeID,
            charterRef: { id: "cht_invalid_budget", version: 1 },
            title: "Invalid budget",
            bossSessionID: "ses_boss",
            seats: [],
            maxModelCalls,
          }),
        ).rejects.toThrow()
      }
    })
  })

  test("events are appended and returned in chronological order", async () => {
    await withScope(async () => {
      const { scopeID, run } = await makeRun()
      await WorkflowRunStore.appendEvent(scopeID, run, { kind: "entity_added", message: "a" })
      await WorkflowRunStore.appendEvent(scopeID, run, { kind: "entity_transitioned", message: "b" })
      const events = await WorkflowRunStore.listEvents(scopeID, run.id)
      // run_created is appended by create(), then the two above.
      const kinds = events.map((e) => e.kind)
      expect(kinds).toEqual(["run_created", "entity_added", "entity_transitioned"])
    })
  })

  test("a stable event id makes audit projection replay idempotent", async () => {
    await withScope(async () => {
      const { scopeID, run } = await makeRun()
      const id = "wfv_stable_gate_opened"

      const first = await WorkflowRunStore.appendEvent(scopeID, run, {
        id,
        kind: "gate_opened",
        data: { gateID: "wfg_stable" },
      })
      const replay = await WorkflowRunStore.appendEvent(scopeID, run, {
        id,
        kind: "gate_opened",
        data: { gateID: "wfg_stable" },
      })

      expect(replay).toEqual(first)
      expect((await WorkflowRunStore.listEvents(scopeID, run.id)).filter((event) => event.id === id)).toHaveLength(1)
    })
  })

  test("effectAlreadyExecuted reflects an effect_executed event's key", async () => {
    await withScope(async () => {
      const { scopeID, run } = await makeRun()
      expect(await WorkflowRunStore.effectAlreadyExecuted(scopeID, run.id, "k1")).toBe(false)
      await WorkflowRunStore.appendEvent(scopeID, run, { kind: "effect_executed", data: { effectKey: "k1" } })
      expect(await WorkflowRunStore.effectAlreadyExecuted(scopeID, run.id, "k1")).toBe(true)
      expect(await WorkflowRunStore.effectAlreadyExecuted(scopeID, run.id, "k2")).toBe(false)
    })
  })

  test("list returns runs newest-first", async () => {
    await withScope(async () => {
      const { scopeID } = await makeRun()
      await new Promise((r) => setTimeout(r, 2))
      await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: "cht_y", version: 1 },
        title: "R2",
        bossSessionID: "ses_boss2",
        seats: [],
        maxModelCalls: 0,
      })
      const runs = await WorkflowRunStore.list(scopeID)
      expect(runs).toHaveLength(2)
      expect(runs[0].time.created).toBeGreaterThanOrEqual(runs[1].time.created)
    })
  })

  test("concurrent updates do not lose writes", async () => {
    await withScope(async () => {
      const { scopeID, run } = await makeRun()
      await Promise.all([
        WorkflowRunStore.update(scopeID, run.id, (draft) => {
          draft.title = "A"
          draft.budget.used = 1
        }),
        WorkflowRunStore.update(scopeID, run.id, (draft) => {
          draft.statusReason = "B"
          draft.budget.used = (draft.budget.used ?? 0) + 1
        }),
      ])
      const latest = await WorkflowRunStore.get(scopeID, run.id)
      expect(latest.revision).toBeGreaterThanOrEqual(2)
      expect(latest.budget.used).toBe(2)
      expect(latest.title === "A" || latest.statusReason === "B").toBe(true)
    })
  })

  test("tryUpdate rejects stale entity state", async () => {
    await withScope(async () => {
      const { scopeID, run } = await makeRun()
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        const entity: WorkflowTypes.Entity = {
          id: "wfe_1",
          runID: run.id,
          title: "E",
          state: "queued",
          bindings: {},
          submissions: [],
          time: { created: Date.now(), updated: Date.now(), stateEntered: Date.now() },
        }
        draft.entities.push(entity)
      })
      const first = await WorkflowRunStore.tryUpdate(
        scopeID,
        run.id,
        (draft) => {
          const entity = draft.entities.find((item) => item.id === "wfe_1")
          if (entity) entity.state = "executing"
        },
        { expectedEntityState: { entityID: "wfe_1", state: "queued" } },
      )
      expect(first.ok).toBe(true)
      const second = await WorkflowRunStore.tryUpdate(
        scopeID,
        run.id,
        (draft) => {
          const entity = draft.entities.find((item) => item.id === "wfe_1")
          if (entity) entity.state = "blocked"
        },
        { expectedEntityState: { entityID: "wfe_1", state: "queued" } },
      )
      expect(second.ok).toBe(false)
      if (!second.ok) expect(second.reason).toBe("conflict")
      const latest = await WorkflowRunStore.get(scopeID, run.id)
      expect(latest.entities[0]?.state).toBe("executing")
    })
  })

  test("tryUpdate rejects a transition after the run leaves active status", async () => {
    await withScope(async () => {
      const { scopeID, run } = await makeRun()
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.status = "cancelled"
        draft.time.completed = Date.now()
      })

      const result = await WorkflowRunStore.tryUpdate(
        scopeID,
        run.id,
        (draft) => {
          draft.title = "must not commit"
        },
        { expectedRunStatus: "active" },
      )

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe("conflict")
      expect((await WorkflowRunStore.get(scopeID, run.id)).title).toBe("R")
    })
  })

  test("getOrUndefined only suppresses a missing run, not corrupted state", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      expect(await WorkflowRunStore.getOrUndefined(scopeID, "wfr_missing")).toBeUndefined()

      const runID = Identifier.ascending("workflow_run")
      await Storage.write(StoragePath.workflowRun(Identifier.asScopeID(scopeID), runID), { corrupt: true })
      await expect(WorkflowRunStore.getOrUndefined(scopeID, runID)).rejects.toThrow()
    })
  })
})
