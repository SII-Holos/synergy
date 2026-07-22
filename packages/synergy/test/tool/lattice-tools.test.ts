import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { LatticeMachine } from "../../src/lattice/machine"
import { LatticeStore } from "../../src/lattice/store"
import { LatticeTypes } from "../../src/lattice/types"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { LatticeSubmitTool } from "../../src/tool/lattice-submit"
import { PathwayReadTool } from "../../src/tool/pathway-read"
import { PathwayWriteTool } from "../../src/tool/pathway-write"
import { ToolRegistry } from "../../src/tool/registry"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

function ctx(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    callID: "call-lattice-test",
    agent: "test-strategist",
    abort: AbortSignal.any([]),
    metadata: () => {},
    ask: async () => {},
  }
}

async function enterPlanning(sessionID: string) {
  const scopeID = ScopeContext.current.scope.id
  const run = await LatticeStore.create({ sessionID, mode: "auto" })
  const queued = LatticeMachine.queueAction(run, {
    id: Identifier.ascending("lattice_action"),
    source: "agent",
    kind: "submit_requirements",
    expectedStateRevision: run.stateRevision,
    expectedPathwayRevision: run.pathwayRevision,
    requirements: {
      goal: "Ship Lattice v2",
      successCriteria: ["All invariants pass"],
      constraints: [],
      nonGoals: [],
      assumptions: [],
    },
    time: { created: Date.now() },
  })
  await LatticeStore.update(scopeID, sessionID, () => queued)
  return LatticeStore.update(scopeID, sessionID, (current) => LatticeMachine.consumePendingAction(current))
}

describe("Lattice tools", () => {
  test("registers only the v2 Lattice tool surface", async () => {
    await withScope(async () => {
      expect(await ToolRegistry.find("pathway_read")).toBeDefined()
      expect(await ToolRegistry.find("pathway_write")).toBeDefined()
      expect(await ToolRegistry.find("lattice_submit")).toBeDefined()
      expect(await ToolRegistry.find("pathway_patch")).toBeUndefined()
    })
  })

  test("pathway_write replaces only future Steps and keeps history immutable", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await enterPlanning(session.id)
      const tool = await PathwayWriteTool.init()

      await tool.execute(
        {
          steps: [
            { title: "Inventory", objective: "Group issues", acceptanceCriteria: ["Inventory is complete"] },
            { title: "Implement", objective: "Land the change" },
          ],
        },
        ctx(session.id),
      )

      const scopeID = ScopeContext.current.scope.id
      const first = await LatticeStore.get(scopeID, session.id)
      const historicalID = first.pathway[0]!.id
      const futureID = first.pathway[1]!.id
      await LatticeStore.update(scopeID, session.id, (draft) => {
        draft.state = "reviewing_pathway"
        draft.stateRevision++
        draft.pathway[0]!.status = "completed"
        draft.pathway[0]!.resultSummary = "Inventory done"
        draft.currentStepID = undefined
      })

      await expect(
        tool.execute(
          { steps: [{ id: historicalID, title: "Rewrite history", objective: "This must be rejected" }] },
          ctx(session.id),
        ),
      ).rejects.toThrow()
      expect((await LatticeStore.get(scopeID, session.id)).pathwayRevision).toBe(1)

      const result = await tool.execute(
        {
          steps: [
            { id: futureID, title: "Implement v2", objective: "Land the focused change" },
            { title: "Verify", objective: "Run the acceptance matrix" },
          ],
        },
        ctx(session.id),
      )

      const updated = await LatticeStore.get(scopeID, session.id)
      expect(updated.pathway.map((step) => step.id)).toEqual([historicalID, futureID, updated.pathway[2]!.id])
      expect(updated.pathway[0]!.resultSummary).toBe("Inventory done")
      expect(updated.pathway[1]!.title).toBe("Implement v2")
      expect(updated.pathwayRevision).toBe(2)
      expect(result.metadata).toMatchObject({ runID: updated.id, total: 3 })
      expect(JSON.parse(result.output)).not.toHaveProperty("pendingAction")
    })
  })

  test("pathway_read returns the public RunView without action, effect, or digests", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const planning = await enterPlanning(session.id)
      const scopeID = ScopeContext.current.scope.id
      const stepID = Identifier.ascending("lattice_step")
      await LatticeStore.update(scopeID, session.id, (draft) => {
        draft.pathway = [
          LatticeTypes.Step.parse({
            id: stepID,
            title: "Private internals",
            objective: "Must be projected",
            status: "pending",
            acceptanceCriteria: [],
            assumptions: [],
            blueprint: {
              noteID: "note-secret",
              boundVersion: 1,
              contentDigest: "private-blueprint-digest",
              reviewedVersion: 1,
              reviewedContentDigest: "private-review-digest",
              time: { bound: Date.now(), reviewed: Date.now() },
            },
            blueprintHistory: [],
            loopHistory: [],
            time: { created: Date.now(), updated: Date.now() },
          }),
        ]
        draft.pathwayRevision++
        draft.pendingAction = {
          id: Identifier.ascending("lattice_action"),
          source: "agent",
          kind: "submit_pathway",
          reason: "private pending reason",
          expectedStateRevision: planning.stateRevision,
          expectedPathwayRevision: planning.pathwayRevision + 1,
          time: { created: Date.now() },
        }
        draft.effect = {
          id: Identifier.ascending("lattice_effect"),
          kind: "deliver_prompt",
          promptType: "state_entry",
          state: "planning",
          deliveryKey: "private-delivery-key",
          attemptCount: 0,
          time: { created: Date.now() },
        }
      })

      const tool = await PathwayReadTool.init()
      const result = await tool.execute({}, ctx(session.id))
      const view = JSON.parse(result.output)

      expect(view).not.toHaveProperty("pendingAction")
      expect(view).not.toHaveProperty("effect")
      expect(result.output).not.toContain("private-blueprint-digest")
      expect(result.output).not.toContain("private-review-digest")
      expect(result.output).not.toContain("private-delivery-key")
      expect(view.pathway[0].blueprint).toEqual({
        noteID: "note-secret",
        boundVersion: 1,
        reviewedVersion: 1,
        time: expect.any(Object),
      })
    })
  })

  test("lattice_submit accepts one strict semantic action and only queues it", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await LatticeStore.create({ sessionID: session.id, mode: "collaborative" })
      const tool = await LatticeSubmitTool.init()

      const result = await tool.execute(
        {
          action: "submit_requirements",
          goal: "Build v2",
          successCriteria: ["Recover after restart"],
          constraints: ["Do not change Session core"],
        },
        ctx(session.id),
      )

      const run = await LatticeStore.get(ScopeContext.current.scope.id, session.id)
      expect(run.state).toBe("clarifying")
      expect(run.pendingAction).toMatchObject({ kind: "submit_requirements", source: "agent" })
      expect(result.metadata).toMatchObject({ action: "submit_requirements", source: "agent" })
      expect(result.output).not.toContain(run.pendingAction!.id)

      await expect(
        tool.execute(
          {
            action: "submit_pathway",
            reason: "Ready",
            blueprintID: "unrelated-field",
          } as never,
          ctx(session.id),
        ),
      ).rejects.toThrow("invalid arguments")
    })
  })
})
