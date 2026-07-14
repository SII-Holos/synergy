import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { WorkflowModelCalls } from "../../src/workflow-run/model-calls"
import { WorkflowRunStore } from "../../src/workflow-run/store"
import { tmpdir } from "../fixture/fixture"

async function withRun<T>(
  fn: (scopeID: string, runID: string) => Promise<T>,
  options: { maxModelCalls?: number } = {},
): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({
    scope,
    fn: async () => {
      const run = await WorkflowRunStore.create({
        scopeID: scope.id,
        charterRef: { id: "cht_budget", version: 1 },
        title: "Budget",
        bossSessionID: "ses_boss",
        seats: [],
        maxModelCalls: options.maxModelCalls ?? 10,
      })
      return fn(scope.id, run.id)
    },
  })
}

describe("WorkflowModelCalls", () => {
  test("attributes Boss, seat, and workflow-owned contractor sessions with their runtime role", () => {
    expect(WorkflowModelCalls.attribution({ workflowRun: { runID: "wfr_boss", role: "boss" } })).toEqual({
      runID: "wfr_boss",
      role: "boss",
    })
    expect(WorkflowModelCalls.attribution({ workflowRun: { runID: "wfr_seat", role: "seat" } })).toEqual({
      runID: "wfr_seat",
      role: "seat",
    })
    expect(
      WorkflowModelCalls.attribution({ cortex: { owner: { kind: "workflow_run", runID: "wfr_contractor" } } }),
    ).toEqual({ runID: "wfr_contractor", role: "contractor" })
    expect(WorkflowModelCalls.attribution({ cortex: { owner: { kind: "plugin" } } })).toBeUndefined()
  })

  test("atomically reserves no more than the run budget under concurrency", async () => {
    await withRun(
      async (scopeID, runID) => {
        const reservations = await Promise.all(
          Array.from({ length: 12 }, () => WorkflowModelCalls.reserve(scopeID, { runID, role: "seat" })),
        )

        expect(reservations.filter((reservation) => reservation.ok)).toHaveLength(3)
        expect(reservations.filter((reservation) => !reservation.ok)).toHaveLength(9)
        expect(
          reservations.filter((reservation) => !reservation.ok && reservation.reason === "budget_exhausted"),
        ).toHaveLength(1)
        const run = await WorkflowRunStore.get(scopeID, runID)
        expect(run.budget.used).toBe(3)
        expect(run.status).toBe("paused")
        expect(run.statusReason).toBe("model_call_budget_exhausted")
        expect(
          (await WorkflowRunStore.listEvents(scopeID, runID)).filter((event) => event.kind === "budget_exhausted"),
        ).toHaveLength(1)
      },
      { maxModelCalls: 3 },
    )
  })

  test("persists every reservation for an unlimited run", async () => {
    await withRun(
      async (scopeID, runID) => {
        const reservations = await Promise.all(
          Array.from({ length: 20 }, () => WorkflowModelCalls.reserve(scopeID, { runID, role: "contractor" })),
        )

        expect(reservations.every((reservation) => reservation.ok)).toBe(true)
        expect((await WorkflowRunStore.get(scopeID, runID)).budget.used).toBe(20)
      },
      { maxModelCalls: 0 },
    )
  })

  test("counts Boss calls against the shared budget while the run is active", async () => {
    await withRun(async (scopeID, runID) => {
      expect(await WorkflowModelCalls.reserve(scopeID, { runID, role: "boss" })).toMatchObject({
        ok: true,
        counted: true,
        used: 1,
      })
      expect((await WorkflowRunStore.get(scopeID, runID)).budget.used).toBe(1)
    })
  })

  test("lets the Boss continue without consuming budget while the run is paused", async () => {
    await withRun(async (scopeID, runID) => {
      await WorkflowRunStore.update(scopeID, runID, (draft) => {
        draft.status = "paused"
      })
      const before = await WorkflowRunStore.get(scopeID, runID)

      expect(await WorkflowModelCalls.reserve(scopeID, { runID, role: "boss" })).toMatchObject({
        ok: true,
        counted: false,
        used: 0,
      })
      const after = await WorkflowRunStore.get(scopeID, runID)
      expect(after.budget.used).toBe(0)
      expect(after.revision).toBe(before.revision)
    })
  })

  test("does not intercept ordinary Boss conversation after the run is terminal", async () => {
    await withRun(async (scopeID, runID) => {
      await WorkflowRunStore.update(scopeID, runID, (draft) => {
        draft.status = "cancelled"
        draft.time.completed = Date.now()
      })
      const before = await WorkflowRunStore.get(scopeID, runID)

      expect(await WorkflowModelCalls.reserve(scopeID, { runID, role: "boss" })).toMatchObject({
        ok: true,
        counted: false,
        used: 0,
      })
      const after = await WorkflowRunStore.get(scopeID, runID)
      expect(after.budget.used).toBe(0)
      expect(after.revision).toBe(before.revision)
    })
  })

  test("fences seat and contractor calls before the provider once the run is terminal", async () => {
    await withRun(async (scopeID, runID) => {
      await WorkflowRunStore.update(scopeID, runID, (draft) => {
        draft.status = "cancelled"
        draft.time.completed = Date.now()
      })
      const terminalRevision = (await WorkflowRunStore.get(scopeID, runID)).revision

      expect(await WorkflowModelCalls.reserve(scopeID, { runID, role: "seat" })).toMatchObject({
        ok: false,
        reason: "run_not_active",
      })
      expect(await WorkflowModelCalls.reserve(scopeID, { runID, role: "contractor" })).toMatchObject({
        ok: false,
        reason: "run_not_active",
      })
      const after = await WorkflowRunStore.get(scopeID, runID)
      expect(after.budget.used).toBe(0)
      expect(after.revision).toBe(terminalRevision)
    })
  })

  test("fences seat and contractor calls before the provider while the run is paused", async () => {
    await withRun(async (scopeID, runID) => {
      await WorkflowRunStore.update(scopeID, runID, (draft) => {
        draft.status = "paused"
      })
      const revision = (await WorkflowRunStore.get(scopeID, runID)).revision

      expect(await WorkflowModelCalls.reserve(scopeID, { runID, role: "seat" })).toMatchObject({
        ok: false,
        reason: "run_not_active",
      })
      expect(await WorkflowModelCalls.reserve(scopeID, { runID, role: "contractor" })).toMatchObject({
        ok: false,
        reason: "run_not_active",
      })
      const after = await WorkflowRunStore.get(scopeID, runID)
      expect(after.budget.used).toBe(0)
      expect(after.revision).toBe(revision)
    })
  })
})
