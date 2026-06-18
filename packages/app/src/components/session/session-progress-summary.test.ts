import { describe, test, expect } from "bun:test"
import {
  computeDagSummary,
  computeTodoSummary,
  computeProgressMode,
  formatProgressText,
  formatRailText,
} from "./session-progress-summary"
import type { DagNode } from "@ericsanchezok/synergy-ui/dag-graph"
import type { TodoItem } from "./session-progress-summary"

// --- Helpers ---

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

// --- computeDagSummary ---

describe("computeDagSummary", () => {
  test("empty array returns zeros and empty collections", () => {
    const result = computeDagSummary([])
    expect(result.total).toBe(0)
    expect(result.completed).toBe(0)
    expect(result.running).toBe(0)
    expect(result.pending).toBe(0)
    expect(result.blocked).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.cancelled).toBe(0)
    expect(result.ready).toEqual([])
    expect(result.activeNodeIds).toEqual([])
    expect(result.attentionLevel).toBe("none")
    expect(result.progressRatio).toBe(0)
  })

  test("single pending node counts correctly", () => {
    const result = computeDagSummary([n("a", "pending")])
    expect(result.total).toBe(1)
    expect(result.pending).toBe(1)
    expect(result.completed).toBe(0)
    expect(result.running).toBe(0)
    expect(result.blocked).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.cancelled).toBe(0)
  })

  test("pending node with no deps is vacuously ready", () => {
    const result = computeDagSummary([n("a", "pending")])
    // empty deps array → every() returns true (vacuous truth)
    expect(result.ready).toEqual(["a"])
  })

  test("pending node with non-existent dep is not ready", () => {
    const result = computeDagSummary([n("a", "pending", ["nonexistent"])])
    expect(result.pending).toBe(1)
    expect(result.ready).toEqual([])
  })

  test("single completed node", () => {
    const result = computeDagSummary([n("a", "completed")])
    expect(result.total).toBe(1)
    expect(result.completed).toBe(1)
    expect(result.progressRatio).toBe(1)
  })

  test("single running node sets attention and activeNodeIds", () => {
    const result = computeDagSummary([n("a", "running")])
    expect(result.running).toBe(1)
    expect(result.attentionLevel).toBe("running")
    expect(result.activeNodeIds).toEqual(["a"])
  })

  test("single blocked node sets attention and activeNodeIds", () => {
    const result = computeDagSummary([n("a", "blocked")])
    expect(result.blocked).toBe(1)
    expect(result.attentionLevel).toBe("blocked")
    expect(result.activeNodeIds).toEqual(["a"])
  })

  test("single failed node sets attention and activeNodeIds", () => {
    const result = computeDagSummary([n("a", "failed")])
    expect(result.failed).toBe(1)
    expect(result.attentionLevel).toBe("failed")
    expect(result.activeNodeIds).toEqual(["a"])
  })

  test("single cancelled node does not set attention", () => {
    const result = computeDagSummary([n("a", "cancelled")])
    expect(result.total).toBe(1)
    expect(result.cancelled).toBe(1)
    expect(result.attentionLevel).toBe("none")
    expect(result.activeNodeIds).toEqual([])
  })

  test("attention priority: failed overrides blocked and running", () => {
    const nodes = [n("r", "running"), n("b", "blocked"), n("f", "failed")]
    const result = computeDagSummary(nodes)
    expect(result.attentionLevel).toBe("failed")
    expect(result.failed).toBe(1)
    expect(result.blocked).toBe(1)
    expect(result.running).toBe(1)
  })

  test("attention priority: blocked overrides running when no failed", () => {
    const nodes = [n("r", "running"), n("b", "blocked")]
    const result = computeDagSummary(nodes)
    expect(result.attentionLevel).toBe("blocked")
  })

  test("attentionLevel is none when only pending and completed", () => {
    const result = computeDagSummary([n("a", "pending"), n("b", "completed")])
    expect(result.attentionLevel).toBe("none")
  })

  test("ready includes pending node whose single dep is completed", () => {
    const result = computeDagSummary([n("a", "completed"), n("b", "pending", ["a"])])
    expect(result.ready).toEqual(["b"])
  })

  test("ready excludes pending node whose dep is still pending", () => {
    const result = computeDagSummary([n("a", "pending"), n("b", "pending", ["a"])])
    // "a" is ready (no deps), "b" is not ready (dep "a" is only pending)
    expect(result.ready).toEqual(["a"])
  })

  test("ready includes pending node whose multiple deps are all completed", () => {
    const result = computeDagSummary([n("a", "completed"), n("b", "completed"), n("c", "pending", ["a", "b"])])
    expect(result.ready).toEqual(["c"])
  })

  test("ready excludes pending node with one dep pending out of multiple", () => {
    const result = computeDagSummary([n("a", "completed"), n("b", "pending"), n("c", "pending", ["a", "b"])])
    // "b" is ready (no deps), "c" is not ready (dep "b" is pending)
    expect(result.ready).toEqual(["b"])
  })

  test("progressRatio for 3 completed out of 7 total", () => {
    const nodes = [
      n("a", "completed"),
      n("b", "completed"),
      n("c", "completed"),
      n("d", "pending"),
      n("e", "pending"),
      n("f", "pending"),
      n("g", "pending"),
    ]
    const result = computeDagSummary(nodes)
    expect(result.total).toBe(7)
    expect(result.completed).toBe(3)
    expect(result.progressRatio).toBe(0.43)
  })

  test("progressRatio includes cancelled nodes in total", () => {
    const result = computeDagSummary([n("a", "completed"), n("b", "cancelled"), n("c", "cancelled"), n("d", "pending")])
    expect(result.total).toBe(4)
    expect(result.completed).toBe(1)
    expect(result.cancelled).toBe(2)
    expect(result.progressRatio).toBe(0.25)
  })

  test("progressRatio is 0 when no nodes completed", () => {
    const result = computeDagSummary([n("a", "pending"), n("b", "pending")])
    expect(result.progressRatio).toBe(0)
  })

  test("activeNodeIds includes running, blocked, and failed but not pending or cancelled", () => {
    const nodes = [n("r", "running"), n("b", "blocked"), n("f", "failed"), n("p", "pending"), n("c", "cancelled")]
    const result = computeDagSummary(nodes)
    expect(result.activeNodeIds).toEqual(["r", "b", "f"])
  })
})

// --- computeTodoSummary ---

describe("computeTodoSummary", () => {
  test("empty array returns zeros", () => {
    const result = computeTodoSummary([])
    expect(result.total).toBe(0)
    expect(result.completed).toBe(0)
    expect(result.inProgress).toBe(0)
    expect(result.pending).toBe(0)
    expect(result.cancelled).toBe(0)
    expect(result.activeTodoIds).toEqual([])
    expect(result.progressRatio).toBe(0)
  })

  test("mixed statuses produce correct counts", () => {
    const todos = [
      t("a", "completed"),
      t("b", "in_progress"),
      t("c", "pending"),
      t("d", "cancelled"),
      t("e", "completed"),
    ]
    const result = computeTodoSummary(todos)
    expect(result.total).toBe(5)
    expect(result.completed).toBe(2)
    expect(result.inProgress).toBe(1)
    expect(result.pending).toBe(1)
    expect(result.cancelled).toBe(1)
  })

  test("all cancelled items produce progressRatio 0", () => {
    const result = computeTodoSummary([t("a", "cancelled"), t("b", "cancelled")])
    expect(result.total).toBe(2)
    expect(result.cancelled).toBe(2)
    expect(result.progressRatio).toBe(0)
  })

  test("in-progress items populate activeTodoIds", () => {
    const result = computeTodoSummary([t("a", "in_progress"), t("b", "pending"), t("c", "in_progress")])
    expect(result.inProgress).toBe(2)
    expect(result.activeTodoIds).toEqual(["a", "c"])
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
    expect(result.total).toBe(6)
    expect(result.cancelled).toBe(1)
    // denominator = 6 - 1 = 5, ratio = 3/5 = 0.6
    expect(result.progressRatio).toBe(0.6)
  })

  test("progressRatio is 1 when all non-cancelled are completed", () => {
    const result = computeTodoSummary([t("a", "completed"), t("b", "completed"), t("c", "cancelled")])
    expect(result.progressRatio).toBe(1)
  })

  test("progressRatio is 0 when only cancelled items exist", () => {
    // all cancelled: denominator = 0, total = 3, fallback = clampRatio(0/3) = 0
    const result = computeTodoSummary([t("a", "cancelled"), t("b", "cancelled"), t("c", "cancelled")])
    expect(result.progressRatio).toBe(0)
  })

  test("progressRatio handles completed and cancelled only", () => {
    // denominator = 3 - 2 = 1, ratio = 1/1 = 1
    const result = computeTodoSummary([t("a", "completed"), t("b", "cancelled"), t("c", "cancelled")])
    expect(result.progressRatio).toBe(1)
  })
})

// --- computeProgressMode ---

describe("computeProgressMode", () => {
  test("both false returns none", () => {
    expect(computeProgressMode(false, false)).toBe("none")
  })

  test("only DAG returns dag", () => {
    expect(computeProgressMode(true, false)).toBe("dag")
  })

  test("only Todo returns todo", () => {
    expect(computeProgressMode(false, true)).toBe("todo")
  })

  test("both true returns both", () => {
    expect(computeProgressMode(true, true)).toBe("both")
  })
})

// --- formatProgressText ---

describe("formatProgressText", () => {
  test("all done returns complete", () => {
    expect(formatProgressText(5, 5)).toBe("complete")
  })

  test("over-completed returns complete", () => {
    expect(formatProgressText(6, 5)).toBe("complete")
  })

  test("partial returns fraction string", () => {
    expect(formatProgressText(3, 7)).toBe("3/7")
  })

  test("nothing done returns 0/5", () => {
    expect(formatProgressText(0, 5)).toBe("0/5")
  })

  test("zero total returns 0/0", () => {
    expect(formatProgressText(0, 0)).toBe("0/0")
  })
})

// --- formatRailText ---

describe("formatRailText", () => {
  test("mode none returns empty string", () => {
    const dag = computeDagSummary([n("a", "running")])
    expect(formatRailText("none", dag)).toBe("")
  })

  test("mode dag with running attention", () => {
    const dag = computeDagSummary([
      n("a", "completed"),
      n("b", "completed"),
      n("c", "running"),
      n("d", "pending"),
      n("e", "pending"),
    ])
    expect(formatRailText("dag", dag)).toBe("DAG 2/5 · running")
  })

  test("mode dag with failed attention", () => {
    const dag = computeDagSummary([
      n("a", "completed"),
      n("b", "completed"),
      n("c", "failed"),
      n("d", "pending"),
      n("e", "pending"),
    ])
    expect(formatRailText("dag", dag)).toBe("DAG 2/5 · failed")
  })

  test("mode dag with blocked attention", () => {
    const dag = computeDagSummary([n("a", "completed"), n("b", "blocked"), n("c", "pending")])
    expect(formatRailText("dag", dag)).toBe("DAG 1/3 · blocked")
  })

  test("mode dag with no attention indicator when all normal", () => {
    const dag = computeDagSummary([n("a", "completed"), n("b", "completed"), n("c", "pending")])
    expect(formatRailText("dag", dag)).toBe("DAG 2/3")
  })

  test("mode dag with zero total returns empty string", () => {
    const dag = computeDagSummary([])
    expect(formatRailText("dag", dag)).toBe("")
  })

  test("mode dag with all completed returns complete indicator", () => {
    const dag = computeDagSummary([n("a", "completed"), n("b", "completed"), n("c", "completed")])
    expect(formatRailText("dag", dag)).toBe("DAG complete")
  })

  test("mode todo with mixed progress", () => {
    const todo = computeTodoSummary([
      t("a", "completed"),
      t("b", "completed"),
      t("c", "completed"),
      t("d", "pending"),
      t("e", "pending"),
      t("f", "pending"),
      t("g", "pending"),
    ])
    expect(formatRailText("todo", undefined, todo)).toBe("Todo 3/7")
  })

  test("mode todo with zero total returns empty string", () => {
    const todo = computeTodoSummary([])
    expect(formatRailText("todo", undefined, todo)).toBe("")
  })

  test("mode both with both present", () => {
    const dag = computeDagSummary([
      n("a", "completed"),
      n("b", "completed"),
      n("c", "pending"),
      n("d", "pending"),
      n("e", "pending"),
    ])
    const todo = computeTodoSummary([
      t("x", "completed"),
      t("y", "completed"),
      t("z", "completed"),
      t("w", "pending"),
      t("v", "pending"),
      t("u", "pending"),
      t("r", "pending"),
    ])
    expect(formatRailText("both", dag, todo)).toBe("DAG 2/5 · Todo 3/7")
  })

  test("mode both when only dag has nodes", () => {
    const dag = computeDagSummary([n("a", "completed"), n("b", "pending")])
    const todo = computeTodoSummary([])
    expect(formatRailText("both", dag, todo)).toBe("DAG 1/2")
  })

  test("mode both when only todo has nodes", () => {
    const dag = computeDagSummary([])
    const todo = computeTodoSummary([t("a", "completed"), t("b", "pending")])
    expect(formatRailText("both", dag, todo)).toBe("Todo 1/2")
  })

  test("mode both when neither has nodes returns empty string", () => {
    expect(formatRailText("both", computeDagSummary([]), computeTodoSummary([]))).toBe("")
  })

  test("mode both with dag all-complete and todo partial", () => {
    const dag = computeDagSummary([n("a", "completed"), n("b", "completed")])
    const todo = computeTodoSummary([t("x", "completed"), t("y", "pending")])
    expect(formatRailText("both", dag, todo)).toBe("DAG complete · Todo 1/2")
  })
})
