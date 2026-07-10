import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { WorkflowRunStore } from "../../src/workflow-run/store"

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
})
