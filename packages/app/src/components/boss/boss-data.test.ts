import { describe, expect, test } from "bun:test"
import type { WorkflowRun, WorkflowEvent } from "@ericsanchezok/synergy-sdk/client"
import { BossData } from "./boss-data"

function event(id: string, created: number, kind: WorkflowEvent["kind"] = "entity_added"): WorkflowEvent {
  return { id, runID: "wfr_1", scopeID: "s", kind, time: { created } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function run(
  entities: { state: string; id: string }[],
  options: { id?: string; bossSessionID?: string; status?: WorkflowRun["status"]; revision?: number } = {},
): WorkflowRun {
  return {
    id: options.id ?? "wfr_1",
    scopeID: "s",
    charterRef: { id: "cht_1", version: 1 },
    title: "R",
    status: options.status ?? "active",
    revision: options.revision,
    bossSessionID: options.bossSessionID ?? "ses_boss",
    seats: [],
    entities: entities.map((e) => ({
      id: e.id,
      runID: "wfr_1",
      title: e.id,
      state: e.state,
      bindings: {},
      submissions: [],
      time: { created: 0, updated: 0, stateEntered: 0 },
    })),
    gates: [],
    budget: { maxModelCalls: 0, used: 0 },
    time: { created: 0, updated: 0 },
  }
}

describe("BossData session ownership", () => {
  test("only exposes active runs owned by the current session", () => {
    const owned = run([], { id: "owned", bossSessionID: "ses_current" })
    const otherBoss = run([], { id: "other", bossSessionID: "ses_other" })
    const completed = run([], { id: "completed", bossSessionID: "ses_current", status: "completed" })

    expect(BossData.activeRunsForSession([owned, otherBoss, completed], "ses_current").map((item) => item.id)).toEqual([
      "owned",
    ])
    expect(BossData.activeRunsForSession([owned], undefined)).toEqual([])
  })

  test("ignores foreign live updates and removes a terminal owned run", () => {
    const first = run([], { id: "first", bossSessionID: "ses_current" })
    const second = run([], { id: "second", bossSessionID: "ses_current" })
    const foreign = run([], { id: "foreign", bossSessionID: "ses_other" })

    expect(BossData.reconcileActiveRun([first, second], foreign, "ses_current")).toEqual([first, second])

    const next = BossData.reconcileActiveRun([first, second], { ...first, status: "completed" }, "ses_current")
    expect(next.map((item) => item.id)).toEqual(["second"])
    expect(BossData.selectRunID(next, first.id)).toBe(second.id)
  })

  test("rejects an older snapshot after a newer live revision", () => {
    const baselineRun = run([], { id: "owned", bossSessionID: "ses_current", revision: 1 })
    const baseline = [baselineRun]
    const live = run([], { id: "owned", bossSessionID: "ses_current", revision: 3 })
    const current = BossData.reconcileActiveRun(baseline, live, "ses_current")
    const staleSnapshot = run([], { id: "owned", bossSessionID: "ses_current", revision: 2 })

    const next = BossData.reconcileRunSnapshot(current, [staleSnapshot], baseline, "ses_current")

    expect(next).toEqual([live])
  })

  test("keeps a run created live while an older list snapshot was in flight", () => {
    const baselineRun = run([], { id: "existing", bossSessionID: "ses_current", revision: 1 })
    const baseline = [baselineRun]
    const created = run([], { id: "created", bossSessionID: "ses_current", revision: 1 })
    const current = BossData.reconcileActiveRun(baseline, created, "ses_current")

    const next = BossData.reconcileRunSnapshot(current, [baselineRun], baseline, "ses_current")

    expect(next.map((item) => item.id)).toEqual(["existing", "created"])
  })

  test("does not resurrect a terminal live revision from a stale active snapshot", () => {
    const baselineRun = run([], { id: "owned", bossSessionID: "ses_current", revision: 1 })
    const terminal = run([], {
      id: "owned",
      bossSessionID: "ses_current",
      revision: 3,
      status: "completed",
    })
    const current = BossData.reconcileActiveRun([baselineRun], terminal, "ses_current")
    const staleSnapshot = run([], { id: "owned", bossSessionID: "ses_current", revision: 2 })

    const next = BossData.reconcileRunSnapshot(current, [staleSnapshot], [baselineRun], "ses_current", [terminal])

    expect(next).toEqual([])
  })
})

describe("BossData latest request", () => {
  test("aborts and ignores an A response after B becomes current", async () => {
    const runner = BossData.createLatestRequestRunner()
    const a = deferred<string>()
    const b = deferred<string>()
    const applied: string[] = []
    let aSignal: AbortSignal | undefined

    const first = runner.run(
      (signal) => {
        aSignal = signal
        return a.promise
      },
      { success: (value) => applied.push(value), failure: () => applied.push("A failed") },
    )
    const second = runner.run(() => b.promise, {
      success: (value) => applied.push(value),
      failure: () => applied.push("B failed"),
    })

    expect(aSignal?.aborted).toBe(true)
    b.resolve("B")
    await second
    a.resolve("A")
    await first

    expect(applied).toEqual(["B"])
  })

  test("reports a current failure without replacing stale state", async () => {
    const runner = BossData.createLatestRequestRunner()
    const request = deferred<string>()
    let state = "stale"
    let error: unknown

    const pending = runner.run(() => request.promise, {
      success: (value) => {
        state = value
      },
      failure: (reason) => {
        error = reason
      },
    })
    request.reject(new Error("offline"))
    await pending

    expect(state).toBe("stale")
    expect(error).toBeInstanceOf(Error)
  })

  test("merges a snapshot with a live event appended while the request was in flight", async () => {
    const runner = BossData.createLatestRequestRunner()
    const snapshot = deferred<WorkflowEvent[]>()
    let events: WorkflowEvent[] = []

    const pending = runner.run(() => snapshot.promise, {
      success: (incoming) => {
        events = BossData.mergeEventSnapshot(events, incoming)
      },
      failure: () => {},
    })
    events = BossData.mergeEvents(events, [{ ...event("shared", 2), message: "live" }, event("live", 3)])
    snapshot.resolve([event("snapshot", 1), { ...event("shared", 2), message: "snapshot" }])
    await pending

    expect(events.map((item) => item.id)).toEqual(["snapshot", "shared", "live"])
    expect(events.find((item) => item.id === "shared")?.message).toBe("live")
  })
})

describe("BossData run list state", () => {
  test("does not expose the empty state before the first list response", () => {
    expect(BossData.runListState(false, [])).toBe("loading")
    expect(BossData.runListState(true, [])).toBe("empty")
    expect(BossData.runListState(true, [run([])])).toBe("ready")
  })
})

describe("BossData.mergeEvents", () => {
  test("de-duplicates by id and sorts chronologically", () => {
    const merged = BossData.mergeEvents([event("b", 2)], [event("a", 1), event("b", 2)])
    expect(merged.map((e) => e.id)).toEqual(["a", "b"])
  })

  test("follows event cursors through the current tail", async () => {
    const cursors: Array<string | undefined> = []
    const items = await BossData.collectEventPages(async (after) => {
      cursors.push(after)
      if (!after) return { items: [event("a", 1)], nextCursor: "a" }
      return { items: [event("b", 2)] }
    })

    expect(cursors).toEqual([undefined, "a"])
    expect(items.map((item) => item.id)).toEqual(["a", "b"])
  })
})

describe("BossData.entitiesByState", () => {
  test("orders by charter state order and puts blocked last", () => {
    const r = run([
      { id: "e1", state: "reviewing" },
      { id: "e2", state: "blocked" },
      { id: "e3", state: "queued" },
    ])
    const groups = BossData.entitiesByState(r, ["queued", "reviewing", "done", "blocked"])
    const nonEmpty = groups.filter((g) => g.entities.length > 0).map((g) => g.state)
    expect(nonEmpty).toEqual(["queued", "reviewing", "blocked"])
  })

  test("still groups entities when the charter (state order) is unavailable", () => {
    // The panel derives the run from list() and may render before the charter
    // loads; the board must not go blank in that window.
    const r = run([
      { id: "e1", state: "executing" },
      { id: "e2", state: "queued" },
    ])
    const groups = BossData.entitiesByState(r, [])
    const nonEmpty = groups.filter((g) => g.entities.length > 0).map((g) => g.state)
    expect(nonEmpty.sort()).toEqual(["executing", "queued"])
  })
})

describe("BossData.eventTone", () => {
  test("flags failure events as errors", () => {
    expect(BossData.eventTone("guard_failed")).toBe("error")
    expect(BossData.eventTone("effect_failed")).toBe("error")
    expect(BossData.eventTone("entity_blocked")).toBe("error")
    expect(BossData.eventTone("budget_exhausted")).toBe("warn")
    expect(BossData.eventTone("entity_transitioned")).toBe("default")
  })
})
