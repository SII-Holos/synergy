import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { SuperPlanStore } from "../../src/superplan"
import { Identifier } from "../../src/id/id"

describe("SuperPlanStore", () => {
  test("creates and lists a run with node dependency metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const firstNodeID = Identifier.ascending("superplan_node")
        const secondNodeID = Identifier.ascending("superplan_node")
        const run = await SuperPlanStore.create({
          title: "Parallel implementation",
          baseCommit: "abc123",
          nodes: [
            {
              id: firstNodeID,
              title: "Foundation",
              blueprintNoteID: "nte_foundation",
            },
            {
              id: secondNodeID,
              title: "Feature layer",
              deps: [firstNodeID],
              blueprintNoteID: "nte_feature",
            },
          ],
        })

        expect(run.scopeID).toBe(scope.id)
        expect(run.status).toBe("planning")
        expect(run.nodes).toHaveLength(2)
        expect(run.nodes[1].deps).toEqual([firstNodeID])
        expect(run.nodes[1].blueprintNoteID).toBe("nte_feature")
        expect(run.nodes[1].baseCommit).toBe("abc123")

        const listed = await SuperPlanStore.list(scope.id)
        expect(listed.map((item) => item.id)).toContain(run.id)
      },
    })
  })

  test("persists run event log entries", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const run = await SuperPlanStore.create({
          title: "Evented run",
        })
        const event = await SuperPlanStore.appendEvent(scope.id, run.id, {
          kind: "wave_ready",
          message: "Wave 0 is ready",
          data: { wave: 0 },
        })

        expect(event.runID).toBe(run.id)
        expect(event.kind).toBe("wave_ready")

        const events = await SuperPlanStore.listEvents(scope.id, run.id)
        expect(events.map((item) => item.id)).toContain(event.id)
        expect(events.some((item) => item.kind === "run_created")).toBe(true)
      },
    })
  })
})
