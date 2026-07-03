import { describe, test, expect } from "bun:test"
import {
  computeDagSummary,
  computeProgressIslandSnapshot,
  computeTodoSummary,
  computeProgressMode,
  formatProgressIslandLabel,
} from "./session-progress-summary"
import type { DagNode } from "@ericsanchezok/synergy-ui/dag-graph"
import type { TodoItem } from "./session-progress-summary"

function n(
  id: string,
  status: string,
  deps: string[] = [],
  extra?: Partial<Omit<DagNode, "id" | "status" | "deps">>,
): DagNode {
  return { id, content: `Task ${id}`, status, deps, ...extra }
}

function t(id: string, status: string, priority?: string): TodoItem {
  return { id, content: `Task ${id}`, status, priority }
}

describe("computeDagSummary", () => {
  test("empty array returns zeros and empty ready set", () => {
    const result = computeDagSummary([])
    expect(result.total).toBe(0)
    expect(result.completed).toBe(0)
    expect(result.running).toBe(0)
    expect(result.pending).toBe(0)
    expect(result.blocked).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.ready).toEqual([])
    expect(result.progressRatio).toBe(0)
  })

  test("counts actionable statuses and excludes cancelled nodes from progress", () => {
    const result = computeDagSummary([
      n("a", "completed"),
      n("b", "running"),
      n("c", "pending"),
      n("d", "blocked"),
      n("e", "failed"),
      n("f", "cancelled"),
    ])

    expect(result.total).toBe(5)
    expect(result.completed).toBe(1)
    expect(result.running).toBe(1)
    expect(result.pending).toBe(1)
    expect(result.blocked).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.progressRatio).toBe(0.2)
  })

  test("cancelled-only DAG work is hidden from current progress", () => {
    const result = computeDagSummary([n("a", "cancelled"), n("b", "cancelled")])
    expect(result.total).toBe(0)
    expect(result.progressRatio).toBe(0)
  })

  test("pending node with no deps is ready", () => {
    const result = computeDagSummary([n("a", "pending")])
    expect(result.ready).toEqual(["a"])
  })

  test("ready includes pending node whose deps are completed", () => {
    const result = computeDagSummary([n("a", "completed"), n("b", "completed"), n("c", "pending", ["a", "b"])])
    expect(result.ready).toEqual(["c"])
  })

  test("ready excludes pending node with missing or incomplete deps", () => {
    const result = computeDagSummary([n("a", "pending"), n("b", "pending", ["a"]), n("c", "pending", ["missing"])])
    expect(result.ready).toEqual(["a"])
  })

  test("progressRatio is rounded to two decimals", () => {
    const result = computeDagSummary([
      n("a", "completed"),
      n("b", "completed"),
      n("c", "completed"),
      n("d", "pending"),
      n("e", "pending"),
      n("f", "pending"),
      n("g", "pending"),
    ])
    expect(result.progressRatio).toBe(0.43)
  })
})

describe("computeTodoSummary", () => {
  test("empty array returns zeros", () => {
    const result = computeTodoSummary([])
    expect(result.total).toBe(0)
    expect(result.completed).toBe(0)
    expect(result.inProgress).toBe(0)
    expect(result.pending).toBe(0)
    expect(result.cancelled).toBe(0)
    expect(result.progressRatio).toBe(0)
  })

  test("mixed statuses produce correct counts", () => {
    const result = computeTodoSummary([
      t("a", "completed"),
      t("b", "in_progress"),
      t("c", "pending"),
      t("d", "cancelled"),
      t("e", "completed"),
    ])
    expect(result.total).toBe(5)
    expect(result.completed).toBe(2)
    expect(result.inProgress).toBe(1)
    expect(result.pending).toBe(1)
    expect(result.cancelled).toBe(1)
  })

  test("progressRatio excludes cancelled from denominator", () => {
    const result = computeTodoSummary([
      t("a", "completed"),
      t("b", "completed"),
      t("c", "completed"),
      t("d", "pending"),
      t("e", "pending"),
      t("f", "cancelled"),
    ])
    expect(result.progressRatio).toBe(0.6)
  })

  test("progressRatio is 1 when all non-cancelled are completed", () => {
    const result = computeTodoSummary([t("a", "completed"), t("b", "completed"), t("c", "cancelled")])
    expect(result.progressRatio).toBe(1)
  })

  test("all cancelled items produce progressRatio 0", () => {
    const result = computeTodoSummary([t("a", "cancelled"), t("b", "cancelled")])
    expect(result.progressRatio).toBe(0)
  })
})

describe("computeProgressMode", () => {
  test("returns the visible progress source", () => {
    expect(computeProgressMode(false, false)).toBe("none")
    expect(computeProgressMode(true, false)).toBe("dag")
    expect(computeProgressMode(false, true)).toBe("todo")
    expect(computeProgressMode(true, true)).toBe("both")
  })
})

describe("computeProgressIslandSnapshot", () => {
  test("returns hidden when there is no DAG or todo progress", () => {
    const snapshot = computeProgressIslandSnapshot("none")
    expect(snapshot.status).toBe("hidden")
    expect(snapshot.total).toBe(0)
    expect(formatProgressIslandLabel(snapshot)).toBe("")
  })

  test("returns hidden when DAG data only contains cancelled nodes", () => {
    const dag = computeDagSummary([n("a", "cancelled")])
    const snapshot = computeProgressIslandSnapshot("dag", dag)

    expect(snapshot.status).toBe("hidden")
    expect(snapshot.total).toBe(0)
  })

  test("returns complete for all finished work without exposing complete fractions", () => {
    const dag = computeDagSummary([n("a", "completed"), n("b", "completed")])
    const todo = computeTodoSummary([t("x", "completed")])
    const snapshot = computeProgressIslandSnapshot("both", dag, todo)

    expect(snapshot.status).toBe("complete")
    expect(snapshot.completed).toBe(3)
    expect(snapshot.total).toBe(3)
    expect(formatProgressIslandLabel(snapshot)).toBe("Done · 3 tasks")
  })

  test("failed work takes attention priority and stays explicit", () => {
    const dag = computeDagSummary([n("a", "running"), n("b", "blocked"), n("c", "failed")])
    const snapshot = computeProgressIslandSnapshot("dag", dag)

    expect(snapshot.status).toBe("attention")
    expect(snapshot.tone).toBe("failed")
    expect(formatProgressIslandLabel(snapshot)).toBe("Needs attention · 1 failed")
  })

  test("blocked work takes attention priority over running work", () => {
    const dag = computeDagSummary([n("a", "running"), n("b", "blocked"), n("c", "pending")])
    const snapshot = computeProgressIslandSnapshot("dag", dag)

    expect(snapshot.status).toBe("attention")
    expect(snapshot.tone).toBe("blocked")
    expect(formatProgressIslandLabel(snapshot)).toBe("Needs attention · 1 blocked")
  })

  test("running work summarizes active and pending counts", () => {
    const dag = computeDagSummary([n("a", "completed"), n("b", "running"), n("c", "pending")])
    const todo = computeTodoSummary([t("x", "in_progress"), t("y", "pending")])
    const snapshot = computeProgressIslandSnapshot("both", dag, todo)

    expect(snapshot.status).toBe("active")
    expect(snapshot.tone).toBe("running")
    expect(snapshot.active).toBe(2)
    expect(snapshot.pending).toBe(2)
    expect(formatProgressIslandLabel(snapshot, "Reviewing changes")).toBe("Reviewing changes · 1/5")
  })

  test("pending-only work remains visible as ready work", () => {
    const dag = computeDagSummary([n("a", "pending"), n("b", "pending")])
    const snapshot = computeProgressIslandSnapshot("dag", dag)

    expect(snapshot.status).toBe("active")
    expect(snapshot.tone).toBe("ready")
    expect(formatProgressIslandLabel(snapshot)).toBe("Ready · 0/2")
  })

  test("pending-only work stays visible without lifecycle suppression", () => {
    const dag = computeDagSummary([n("a", "pending"), n("b", "pending")])
    const snapshot = computeProgressIslandSnapshot("dag", dag)

    expect(snapshot.status).toBe("active")
    expect(snapshot.tone).toBe("ready")
    expect(snapshot.total).toBe(2)
  })

  test("work with attention stays visible", () => {
    const dag = computeDagSummary([n("a", "completed"), n("b", "blocked"), n("c", "pending")])
    const snapshot = computeProgressIslandSnapshot("dag", dag)

    expect(snapshot.status).toBe("attention")
    expect(snapshot.tone).toBe("blocked")
  })

  test("incomplete non-terminal DAG work remains visible as ready work", () => {
    const dag = computeDagSummary([n("a", "completed"), n("b", "pending"), n("c", "pending")])
    const snapshot = computeProgressIslandSnapshot("dag", dag)

    expect(snapshot.status).toBe("active")
    expect(snapshot.tone).toBe("ready")
    expect(snapshot.total).toBe(3)
  })

  test("running DAG work remains visible without idle-as-settled suppression", () => {
    const dag = computeDagSummary([n("a", "completed"), n("b", "running"), n("c", "pending")])
    const snapshot = computeProgressIslandSnapshot("dag", dag)

    expect(snapshot.status).toBe("active")
    expect(snapshot.tone).toBe("running")
    expect(snapshot.total).toBe(3)
  })

  test("fully-completed work shows complete", () => {
    const dag = computeDagSummary([n("a", "completed"), n("b", "completed")])
    const snapshot = computeProgressIslandSnapshot("dag", dag)

    expect(snapshot.status).toBe("complete")
  })
})
