import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { Hono } from "hono"
import { Identifier } from "../../src/id/id"
import { LatticeStore } from "../../src/lattice/store"
import { LatticeRunService } from "../../src/lattice/run-service"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { LatticeRoute } from "../../src/server/lattice"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

setDefaultTimeout(30_000)

function app() {
  return new Hono().route("/lattice", LatticeRoute)
}

async function withScope<T>(fn: (scope: Scope) => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn: () => fn(scope) })
}

describe("LatticeRoute", () => {
  test("projects current and historical Runs through LatticeRunView", async () => {
    await withScope(async (scope) => {
      const session = await Session.create({})
      const first = await LatticeStore.create({ sessionID: session.id, mode: "auto", goal: "First goal" })
      await LatticeStore.updateByRunID(scope.id, first.id, (draft) => {
        draft.status = "completed"
        draft.time.completed = Date.now()
      })
      const current = await LatticeStore.create({
        sessionID: session.id,
        mode: "collaborative",
        goal: "Current goal",
      })
      await LatticeStore.updateByRunID(scope.id, current.id, (draft) => {
        draft.pendingAction = {
          id: Identifier.ascending("lattice_action"),
          source: "agent",
          kind: "submit_requirements",
          requirements: {
            goal: "Private action",
            successCriteria: ["Never expose this action"],
            constraints: [],
            nonGoals: [],
            assumptions: [],
          },
          expectedStateRevision: draft.stateRevision,
          expectedPathwayRevision: draft.pathwayRevision,
          time: { created: Date.now() },
        }
        draft.effect = {
          id: Identifier.ascending("lattice_effect"),
          kind: "deliver_prompt",
          promptType: "state_entry",
          state: "clarifying",
          deliveryKey: "lattice-private-delivery-key",
          deliveredMessageID: Identifier.ascending("message"),
          attemptCount: 1,
          time: { created: Date.now() },
        }
      })

      const currentResponse = await app().request(`/lattice/session/${session.id}`)
      expect(currentResponse.status).toBe(200)
      const currentBody = await currentResponse.json()
      expect(currentBody.id).toBe(current.id)
      expect(currentBody).not.toHaveProperty("pendingAction")
      expect(currentBody).not.toHaveProperty("effect")

      const listResponse = await app().request("/lattice/run")
      expect(listResponse.status).toBe(200)
      const list = (await listResponse.json()) as Record<string, unknown>[]
      expect(list.map((run) => run.id)).toEqual([first.id, current.id])
      expect(list.every((run) => !("pendingAction" in run) && !("effect" in run))).toBe(true)

      const runResponse = await app().request(`/lattice/run/${current.id}`)
      expect(runResponse.status).toBe(200)
      expect(await runResponse.json()).toEqual(currentBody)

      const missingSession = await app().request("/lattice/session/ses_missing")
      expect(missingSession.status).toBe(200)
      expect(await missingSession.json()).toBeNull()
    })
  })

  test("isolates run and event reads by current Scope", async () => {
    await using firstTmp = await tmpdir({ git: true })
    await using secondTmp = await tmpdir({ git: true })
    const firstScope = (await Scope.fromDirectory(firstTmp.path)).scope
    const secondScope = (await Scope.fromDirectory(secondTmp.path)).scope

    const run = await ScopeContext.provide({
      scope: firstScope,
      fn: async () => {
        const session = await Session.create({})
        const created = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
        await LatticeStore.appendEvent(firstScope.id, created, {
          kind: "run_updated",
          state: created.state,
          message: "Scoped audit entry",
        })
        const otherSession = await Session.create({})
        const otherRun = await LatticeStore.create({ sessionID: otherSession.id, mode: "collaborative" })
        await LatticeStore.appendEvent(firstScope.id, otherRun, {
          kind: "run_updated",
          state: otherRun.state,
          message: "Other Run audit entry",
        })
        const response = await app().request(`/lattice/run/${created.id}/events`)
        expect(response.status).toBe(200)
        const events = (await response.json()) as { runID: string; message?: string }[]
        expect(events.some((event) => event.runID === created.id && event.message === "Scoped audit entry")).toBe(true)
        expect(events.every((event) => event.runID === created.id)).toBe(true)
        return created
      },
    })

    await ScopeContext.provide({
      scope: secondScope,
      fn: async () => {
        expect((await app().request(`/lattice/run/${run.id}`)).status).toBe(404)
        expect((await app().request(`/lattice/run/${run.id}/events`)).status).toBe(404)
        expect((await app().request(`/lattice/run/${run.id}/cancel`, { method: "POST" })).status).toBe(404)
      },
    })
  })

  test("exposes pause/resume/cancel/approve with strict validation and conflict status", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeStore.create({ sessionID: session.id, mode: "collaborative" })

      const invalid = await app().request(`/lattice/run/${run.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userPrompt: "Do extra work while approving" }),
      })
      expect(invalid.status).toBe(400)

      const approve = await app().request(`/lattice/run/${run.id}/approve`, { method: "POST" })
      expect(approve.status).toBe(409)

      const resume = await app().request(`/lattice/run/${run.id}/resume`, { method: "POST" })
      expect(resume.status).toBe(200)
      expect(await resume.json()).toMatchObject({ id: run.id, status: "active" })

      const pause = await app().request(`/lattice/run/${run.id}/pause`, { method: "POST" })
      expect(pause.status).toBe(200)
      expect(await pause.json()).toMatchObject({ id: run.id, status: "paused" })

      const cancel = await app().request(`/lattice/run/${run.id}/cancel`, { method: "POST" })
      expect(cancel.status).toBe(200)
      const cancelled = await cancel.json()
      expect(cancelled).toMatchObject({ id: run.id, status: "cancelled" })
      expect(cancelled).not.toHaveProperty("effect")
      expect(cancelled).not.toHaveProperty("pendingAction")

      expect((await app().request(`/lattice/run/${run.id}/continue`, { method: "POST" })).status).toBe(404)
    })
  })

  test("reserves 400 for validation and reports unexpected lifecycle failures as 500", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
      const cancel = spyOn(LatticeRunService, "cancel").mockRejectedValueOnce(new Error("sensitive storage failure"))

      try {
        const response = await app().request(`/lattice/run/${run.id}/cancel`, { method: "POST" })
        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ message: "Internal server error" })
      } finally {
        cancel.mockRestore()
      }
    })
  })
})
