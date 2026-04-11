import { describe, expect, test } from "bun:test"
import { Dag } from "../../src/session/dag"

describe("Dag.validate", () => {
  describe("Layer 1: Duplicate IDs", () => {
    test("rejects duplicate node IDs", () => {
      const result = Dag.validate([
        { id: "a", content: "Task A", status: "pending", deps: [] },
        { id: "a", content: "Task B", status: "pending", deps: [] },
      ])
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain("Duplicate")
    })
  })

  describe("Layer 2: Status enum", () => {
    test("rejects invalid status", () => {
      const result = Dag.validate([{ id: "a", content: "Task", status: "done", deps: [] }])
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain("invalid status")
    })

    test("accepts all valid statuses", () => {
      for (const status of Dag.VALID_STATUSES) {
        const result = Dag.validate([{ id: "a", content: "Task", status, deps: [] }])
        expect(result.valid).toBe(true)
      }
    })
  })

  describe("Layer 3: Auto-fix", () => {
    test("strips unknown deps", () => {
      const result = Dag.validate([{ id: "a", content: "Task", status: "pending", deps: ["nonexistent"] }])
      expect(result.valid).toBe(true)
      expect(result.nodes[0].deps).toEqual([])
      expect(result.fixes.length).toBe(1)
      expect(result.fixes[0]).toContain("nonexistent")
    })

    test("strips self-dependencies", () => {
      const result = Dag.validate([{ id: "a", content: "Task", status: "pending", deps: ["a"] }])
      expect(result.valid).toBe(true)
      expect(result.nodes[0].deps).toEqual([])
      expect(result.fixes[0]).toContain("self-dependency")
    })

    test("removes invalid assign value", () => {
      const result = Dag.validate([{ id: "a", content: "Task", status: "pending", deps: [], assign: "researcher" }])
      expect(result.valid).toBe(true)
      expect(result.nodes[0].assign).toBeUndefined()
      expect(result.fixes[0]).toContain("researcher")
    })

    test("keeps valid assign value", () => {
      const result = Dag.validate([{ id: "a", content: "Task", status: "pending", deps: [], assign: "explore" }])
      expect(result.valid).toBe(true)
      expect(result.nodes[0].assign).toBe("explore")
      expect(result.fixes.length).toBe(0)
    })
  })

  describe("Layer 4: Cycle detection", () => {
    test("detects simple cycle", () => {
      const result = Dag.validate([
        { id: "a", content: "A", status: "pending", deps: ["b"] },
        { id: "b", content: "B", status: "pending", deps: ["a"] },
      ])
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain("Circular")
    })

    test("detects transitive cycle", () => {
      const result = Dag.validate([
        { id: "a", content: "A", status: "pending", deps: ["c"] },
        { id: "b", content: "B", status: "pending", deps: ["a"] },
        { id: "c", content: "C", status: "pending", deps: ["b"] },
      ])
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain("Circular")
    })

    test("accepts valid DAG with diamond dependency", () => {
      const result = Dag.validate([
        { id: "a", content: "A", status: "pending", deps: [] },
        { id: "b", content: "B", status: "pending", deps: ["a"] },
        { id: "c", content: "C", status: "pending", deps: ["a"] },
        { id: "d", content: "D", status: "pending", deps: ["b", "c"] },
      ])
      expect(result.valid).toBe(true)
    })
  })

  describe("Layer 5: Evolution consistency", () => {
    test("warns on dropping completed nodes from active DAG", () => {
      const previous: Dag.Node[] = [
        { id: "a", content: "Done", status: "completed", deps: [] },
        { id: "b", content: "Todo", status: "pending", deps: ["a"] },
      ]
      const result = Dag.validate([{ id: "b", content: "Todo", status: "pending", deps: [] }], previous)
      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.includes("Completed node") && w.includes("dropped"))).toBe(true)
    })

    test("skips evolution checks when previous DAG is fully terminal with no ID overlap", () => {
      const previous: Dag.Node[] = [
        { id: "old-a", content: "Done A", status: "completed", deps: [] },
        { id: "old-b", content: "Done B", status: "completed", deps: ["old-a"] },
      ]
      const result = Dag.validate(
        [
          { id: "new-x", content: "New task X", status: "pending", deps: [] },
          { id: "new-y", content: "New task Y", status: "pending", deps: ["new-x"] },
        ],
        previous,
      )
      expect(result.valid).toBe(true)
      expect(result.warnings.length).toBe(0)
    })

    test("skips evolution checks when previous DAG has mixed terminal states", () => {
      const previous: Dag.Node[] = [
        { id: "old-a", content: "Done", status: "completed", deps: [] },
        { id: "old-b", content: "Cancelled", status: "cancelled", deps: [] },
        { id: "old-c", content: "Failed", status: "failed", deps: [] },
      ]
      const result = Dag.validate([{ id: "fresh", content: "Fresh start", status: "pending", deps: [] }], previous)
      expect(result.valid).toBe(true)
      expect(result.warnings.length).toBe(0)
    })

    test("still warns when previous DAG is terminal but IDs overlap", () => {
      const previous: Dag.Node[] = [
        { id: "a", content: "Done", status: "completed", deps: [] },
        { id: "b", content: "Done", status: "completed", deps: ["a"] },
      ]
      const result = Dag.validate(
        [
          { id: "a", content: "Reused ID", status: "pending", deps: [] },
          { id: "c", content: "New node", status: "pending", deps: ["a"] },
        ],
        previous,
      )
      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.includes("completed node") && w.includes("changed"))).toBe(true)
    })

    test("warns on changing completed node status", () => {
      const previous: Dag.Node[] = [{ id: "a", content: "Done", status: "completed", deps: [] }]
      const result = Dag.validate([{ id: "a", content: "Done", status: "pending", deps: [] }], previous)
      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.includes("completed node") && w.includes("changed"))).toBe(true)
    })

    test("warns on dropping running nodes", () => {
      const previous: Dag.Node[] = [
        { id: "a", content: "Running", status: "running", deps: [] },
        { id: "b", content: "Other", status: "pending", deps: ["a"] },
      ]
      const result = Dag.validate([{ id: "b", content: "Other", status: "pending", deps: [] }], previous)
      expect(result.warnings.some((w) => w.includes("Running node") && w.includes("dropped"))).toBe(true)
    })

    test("warns on unusual status transition", () => {
      const previous: Dag.Node[] = [{ id: "a", content: "Task", status: "pending", deps: [] }]
      const result = Dag.validate([{ id: "a", content: "Task", status: "completed", deps: [] }], previous)
      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.includes("Unusual status transition"))).toBe(true)
    })

    test("allows valid status transition", () => {
      const previous: Dag.Node[] = [{ id: "a", content: "Task", status: "pending", deps: [] }]
      const result = Dag.validate([{ id: "a", content: "Task", status: "running", deps: [] }], previous)
      expect(result.valid).toBe(true)
      expect(result.warnings.length).toBe(0)
    })

    test("allows retry: failed → pending", () => {
      const previous: Dag.Node[] = [{ id: "a", content: "Task", status: "failed", deps: [] }]
      const result = Dag.validate([{ id: "a", content: "Task (revised)", status: "pending", deps: [] }], previous)
      expect(result.valid).toBe(true)
      expect(result.warnings.length).toBe(0)
    })

    test("warns on modified completed node content", () => {
      const previous: Dag.Node[] = [{ id: "a", content: "Original", status: "completed", deps: [] }]
      const result = Dag.validate([{ id: "a", content: "Modified", status: "completed", deps: [] }], previous)
      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.includes("Content of completed node"))).toBe(true)
    })
  })

  describe("Layer 6: Semantic warnings", () => {
    test("warns when running node has non-completed deps", () => {
      const result = Dag.validate([
        { id: "a", content: "A", status: "pending", deps: [] },
        { id: "b", content: "B", status: "running", deps: ["a"] },
      ])
      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.includes("running") && w.includes("dep"))).toBe(true)
    })

    test("warns when pending node depends on failed node", () => {
      const result = Dag.validate([
        { id: "a", content: "A", status: "failed", deps: [] },
        { id: "b", content: "B", status: "pending", deps: ["a"] },
      ])
      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.includes("never become ready"))).toBe(true)
    })

    test("warns when no root nodes", () => {
      const result = Dag.validate([
        { id: "a", content: "A", status: "pending", deps: ["b"] },
        { id: "b", content: "B", status: "pending", deps: ["a"] },
      ])
      // This will actually be caught by cycle detection first
      expect(result.valid).toBe(false)
    })
  })

  describe("Empty DAG", () => {
    test("rejects empty node list", () => {
      const result = Dag.validate([])
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain("empty")
    })
  })

  describe("No previous DAG (first creation)", () => {
    test("works without previous DAG", () => {
      const result = Dag.validate([
        { id: "a", content: "A", status: "pending", deps: [] },
        { id: "b", content: "B", status: "pending", deps: ["a"] },
      ])
      expect(result.valid).toBe(true)
      expect(result.errors.length).toBe(0)
    })
  })
})

describe("Dag.computeReady", () => {
  test("identifies root pending nodes as ready", () => {
    const ready = Dag.computeReady([
      { id: "a", content: "A", status: "pending", deps: [] },
      { id: "b", content: "B", status: "pending", deps: ["a"] },
    ])
    expect(ready).toEqual(["a"])
  })

  test("identifies nodes with all completed deps as ready", () => {
    const ready = Dag.computeReady([
      { id: "a", content: "A", status: "completed", deps: [] },
      { id: "b", content: "B", status: "completed", deps: [] },
      { id: "c", content: "C", status: "pending", deps: ["a", "b"] },
    ])
    expect(ready).toEqual(["c"])
  })

  test("does not mark running nodes as ready", () => {
    const ready = Dag.computeReady([
      { id: "a", content: "A", status: "completed", deps: [] },
      { id: "b", content: "B", status: "running", deps: ["a"] },
    ])
    expect(ready).toEqual([])
  })

  test("returns empty for empty DAG", () => {
    expect(Dag.computeReady([])).toEqual([])
  })
})
