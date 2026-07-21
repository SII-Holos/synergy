import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { LatticeStore } from "../../src/lattice/store"
import { LatticeMachine } from "../../src/lattice/machine"
import { LatticeError } from "../../src/lattice/error"
import { LatticeTypes } from "../../src/lattice/types"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

async function newRun(mode: LatticeTypes.Mode = "auto") {
  const session = await Session.create({})
  const run = await LatticeStore.reset({ sessionID: session.id, mode })
  return { scopeID: ScopeContext.current.scope.id, sessionID: session.id, run }
}

describe("LatticeMachine pathway + transitions", () => {
  test("initial pathway selects the first step and moves to step_blueprinting", async () => {
    await withScope(async () => {
      const { scopeID, sessionID } = await newRun("auto")
      const run = await LatticeMachine.patch(scopeID, sessionID, {
        steps: [
          { title: "A", objective: "do a" },
          { title: "B", objective: "do b" },
        ],
      })
      expect(run.phase).toBe("step_blueprinting")
      expect(run.pathway).toHaveLength(2)
      expect(run.currentStepID).toBe(run.pathway[0].id)
      expect(run.pathway[0].status).toBe("ready")
    })
  })

  test("auto: binding a Blueprint moves to blueprint_execution", async () => {
    await withScope(async () => {
      const { scopeID, sessionID } = await newRun("auto")
      await LatticeMachine.patch(scopeID, sessionID, { steps: [{ title: "A", objective: "do a" }] })
      const run = await LatticeMachine.patch(scopeID, sessionID, {
        bindCurrentBlueprint: { noteID: "note_x" },
      })
      expect(run.phase).toBe("blueprint_execution")
      expect(LatticeMachine.currentStep(run)?.blueprintNoteID).toBe("note_x")
    })
  })

  test("collaborative: binding a Blueprint moves to blueprint_review", async () => {
    await withScope(async () => {
      const { scopeID, sessionID } = await newRun("collaborative")
      await LatticeMachine.patch(scopeID, sessionID, { steps: [{ title: "A", objective: "do a" }] })
      const run = await LatticeMachine.patch(scopeID, sessionID, { bindCurrentBlueprint: { noteID: "note_x" } })
      expect(run.phase).toBe("blueprint_review")
      expect(LatticeMachine.currentStep(run)?.status).toBe("reviewing")
    })
  })

  test("loop lifecycle: started → completed → result_analysis, then next step", async () => {
    await withScope(async () => {
      const { scopeID, sessionID } = await newRun("auto")
      await LatticeMachine.patch(scopeID, sessionID, {
        steps: [
          { title: "A", objective: "do a" },
          { title: "B", objective: "do b" },
        ],
      })
      const bound = await LatticeMachine.patch(scopeID, sessionID, { bindCurrentBlueprint: { noteID: "note_a" } })
      const stepA = bound.currentStepID!
      await LatticeMachine.onLoopStarted(scopeID, sessionID, stepA, "bll_a")
      const completed = await LatticeMachine.onLoopCompleted(scopeID, sessionID, "bll_a", "done a")
      expect(completed?.phase).toBe("result_analysis")
      expect(completed?.pathway.find((s) => s.id === stepA)?.status).toBe("completed")

      // Recording the result advances to the next step.
      const advanced = await LatticeMachine.patch(scopeID, sessionID, {
        recordResult: { stepID: stepA, resultSummary: "ok" },
      })
      expect(advanced.phase).toBe("step_blueprinting")
      expect(advanced.currentStepID).not.toBe(stepA)
    })
  })

  test("failure keeps the step failed and a recovery step can reference it", async () => {
    await withScope(async () => {
      const { scopeID, sessionID } = await newRun("auto")
      await LatticeMachine.patch(scopeID, sessionID, { steps: [{ title: "A", objective: "do a" }] })
      const bound = await LatticeMachine.patch(scopeID, sessionID, { bindCurrentBlueprint: { noteID: "note_a" } })
      const stepA = bound.currentStepID!
      await LatticeMachine.onLoopStarted(scopeID, sessionID, stepA, "bll_a")
      const failed = await LatticeMachine.onLoopFailed(scopeID, sessionID, "bll_a", "boom")
      expect(failed?.pathway.find((s) => s.id === stepA)?.status).toBe("failed")
      expect(failed?.phase).toBe("result_analysis")

      const recovered = await LatticeMachine.patch(scopeID, sessionID, {
        steps: [{ title: "A2", objective: "fix a", addressesFailedStepIDs: [stepA] }],
      })
      const failedStep = recovered.pathway.find((s) => s.id === stepA)
      expect(failedStep?.status).toBe("failed") // still failed
      const recovery = recovered.pathway.find((s) => s.title === "A2")
      expect(recovery?.addressesFailedStepIDs).toEqual([stepA])
    })
  })

  test("terminal steps are immutable via steps replacement", async () => {
    await withScope(async () => {
      const { scopeID, sessionID } = await newRun("auto")
      await LatticeMachine.patch(scopeID, sessionID, { steps: [{ title: "A", objective: "do a" }] })
      const bound = await LatticeMachine.patch(scopeID, sessionID, { bindCurrentBlueprint: { noteID: "note_a" } })
      const stepA = bound.currentStepID!
      await LatticeMachine.onLoopStarted(scopeID, sessionID, stepA, "bll_a")
      await LatticeMachine.onLoopCompleted(scopeID, sessionID, "bll_a", "done")

      await expect(
        LatticeMachine.patch(scopeID, sessionID, { steps: [{ id: stepA, title: "A!", objective: "x" }] }),
      ).rejects.toThrow(LatticeError.InvalidPathway)
    })
  })

  test("duplicate step ids are rejected", async () => {
    await withScope(async () => {
      const { scopeID, sessionID } = await newRun("auto")
      const run = await LatticeMachine.patch(scopeID, sessionID, {
        steps: [{ title: "A", objective: "do a" }],
      })
      const id = run.pathway[0].id
      await expect(
        LatticeMachine.patch(scopeID, sessionID, {
          steps: [
            { id, title: "A", objective: "do a" },
            { id, title: "dup", objective: "dup" },
          ],
        }),
      ).rejects.toThrow(LatticeError.InvalidPathway)
    })
  })

  test("pathway cannot be restructured during blueprint_execution", async () => {
    await withScope(async () => {
      const { scopeID, sessionID } = await newRun("auto")
      await LatticeMachine.patch(scopeID, sessionID, { steps: [{ title: "A", objective: "do a" }] })
      await LatticeMachine.patch(scopeID, sessionID, { bindCurrentBlueprint: { noteID: "note_a" } })
      // now phase is blueprint_execution
      await expect(
        LatticeMachine.patch(scopeID, sessionID, { steps: [{ title: "B", objective: "b" }] }),
      ).rejects.toThrow(LatticeError.PhaseViolation)
    })
  })

  test("completing the last step completes the run", async () => {
    await withScope(async () => {
      const { scopeID, sessionID } = await newRun("auto")
      await LatticeMachine.patch(scopeID, sessionID, { steps: [{ title: "A", objective: "do a" }] })
      const bound = await LatticeMachine.patch(scopeID, sessionID, { bindCurrentBlueprint: { noteID: "note_a" } })
      const stepA = bound.currentStepID!
      await LatticeMachine.onLoopStarted(scopeID, sessionID, stepA, "bll_a")
      await LatticeMachine.onLoopCompleted(scopeID, sessionID, "bll_a", "done")
      const done = await LatticeMachine.patch(scopeID, sessionID, { recordResult: { stepID: stepA } })
      expect(done.status).toBe("completed")
      expect(done.currentStepID).toBeUndefined()
    })
  })

  test("pause reverts a running step and resume restarts execution phase", async () => {
    await withScope(async () => {
      const { scopeID, sessionID } = await newRun("auto")
      await LatticeMachine.patch(scopeID, sessionID, { steps: [{ title: "A", objective: "do a" }] })
      const bound = await LatticeMachine.patch(scopeID, sessionID, { bindCurrentBlueprint: { noteID: "note_a" } })
      const stepA = bound.currentStepID!
      await LatticeMachine.onLoopStarted(scopeID, sessionID, stepA, "bll_a")

      const paused = await LatticeMachine.pause(scopeID, sessionID, "user_exit")
      expect(paused.status).toBe("paused")
      expect(paused.pathway.find((s) => s.id === stepA)?.status).toBe("ready")
      expect(paused.pathway.find((s) => s.id === stepA)?.blueprintLoopID).toBeUndefined()

      const resumed = await LatticeMachine.resume(scopeID, sessionID)
      expect(resumed.status).toBe("active")
      expect(resumed.phase).toBe("blueprint_execution") // bound note → execution
    })
  })

  test("budget exhaustion pauses the run with a reason", async () => {
    await withScope(async () => {
      const { scopeID, sessionID } = await newRun("auto")
      const run = await LatticeMachine.markBudgetExhausted(scopeID, sessionID)
      expect(run.status).toBe("paused")
      expect(run.statusReason).toBe("model_call_budget_exhausted")
    })
  })
})
