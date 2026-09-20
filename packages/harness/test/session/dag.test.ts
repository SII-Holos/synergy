import { describe, expect, test } from "bun:test"
import { Dag } from "../../src/session/dag"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("Dag.validate", () => {
  describe("Layer 1: Duplicate IDs", () => {
    test("rejects duplicate node IDs", () =>
      runtime.run(() => {
        const result = Dag.validate([
          { id: "a", content: "Task A", status: "pending", deps: [] },
          { id: "a", content: "Task B", status: "pending", deps: [] },
        ])
        expect(result.valid).toBe(false)
        expect(result.errors[0]).toContain("Duplicate")
      }))
  })

  describe("Layer 2: Status enum", () => {
    test("rejects invalid status", () =>
      runtime.run(() => {
        const result = Dag.validate([{ id: "a", content: "Task", status: "done", deps: [] }])
        expect(result.valid).toBe(false)
        expect(result.errors[0]).toContain("invalid status")
      }))

    test("accepts all valid statuses", () =>
      runtime.run(() => {
        for (const status of Dag.VALID_STATUSES) {
          const result = Dag.validate([{ id: "a", content: "Task", status, deps: [] }])
          expect(result.valid).toBe(true)
        }
      }))
  })

  describe("Layer 3: Auto-fix", () => {
    test("strips unknown deps", () =>
      runtime.run(() => {
        const result = Dag.validate([{ id: "a", content: "Task", status: "pending", deps: ["nonexistent"] }])
        expect(result.valid).toBe(true)
        expect(result.nodes[0].deps).toEqual([])
        expect(result.fixes.length).toBe(1)
        expect(result.fixes[0]).toContain("nonexistent")
      }))

    test("strips self-dependencies", () =>
      runtime.run(() => {
        const result = Dag.validate([{ id: "a", content: "Task", status: "pending", deps: ["a"] }])
        expect(result.valid).toBe(true)
        expect(result.nodes[0].deps).toEqual([])
        expect(result.fixes[0]).toContain("self-dependency")
      }))

    test("removes invalid assign value", () =>
      runtime.run(() => {
        const result = Dag.validate([{ id: "a", content: "Task", status: "pending", deps: [], assign: "researcher" }])
        expect(result.valid).toBe(true)
        expect(result.nodes[0].assign).toBeUndefined()
        expect(result.fixes[0]).toContain("researcher")
      }))

    test("keeps valid assign value", () =>
      runtime.run(() => {
        const result = Dag.validate([{ id: "a", content: "Task", status: "pending", deps: [], assign: "explore" }])
        expect(result.valid).toBe(true)
        expect(result.nodes[0].assign).toBe("explore")
        expect(result.fixes.length).toBe(0)
      }))
  })

  describe("Layer 4: Cycle detection", () => {
    test("detects simple cycle", () =>
      runtime.run(() => {
        const result = Dag.validate([
          { id: "a", content: "A", status: "pending", deps: ["b"] },
          { id: "b", content: "B", status: "pending", deps: ["a"] },
        ])
        expect(result.valid).toBe(false)
        expect(result.errors[0]).toContain("Circular")
      }))

    test("detects transitive cycle", () =>
      runtime.run(() => {
        const result = Dag.validate([
          { id: "a", content: "A", status: "pending", deps: ["c"] },
          { id: "b", content: "B", status: "pending", deps: ["a"] },
          { id: "c", content: "C", status: "pending", deps: ["b"] },
        ])
        expect(result.valid).toBe(false)
        expect(result.errors[0]).toContain("Circular")
      }))

    test("accepts valid DAG with diamond dependency", () =>
      runtime.run(() => {
        const result = Dag.validate([
          { id: "a", content: "A", status: "pending", deps: [] },
          { id: "b", content: "B", status: "pending", deps: ["a"] },
          { id: "c", content: "C", status: "pending", deps: ["a"] },
          { id: "d", content: "D", status: "pending", deps: ["b", "c"] },
        ])
        expect(result.valid).toBe(true)
      }))
  })

  describe("Layer 5: Evolution consistency", () => {
    test("warns on dropping completed nodes from active DAG", () =>
      runtime.run(() => {
        const previous: Dag.Node[] = [
          { id: "a", content: "Done", status: "completed", deps: [] },
          { id: "b", content: "Todo", status: "pending", deps: ["a"] },
        ]
        const result = Dag.validate([{ id: "b", content: "Todo", status: "pending", deps: [] }], previous)
        expect(result.valid).toBe(true)
        expect(result.warnings.some((w) => w.includes("Completed node") && w.includes("dropped"))).toBe(true)
      }))

    test("skips evolution checks when previous DAG is fully terminal with no ID overlap", () =>
      runtime.run(() => {
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
      }))

    test("skips evolution checks when previous DAG has mixed terminal states", () =>
      runtime.run(() => {
        const previous: Dag.Node[] = [
          { id: "old-a", content: "Done", status: "completed", deps: [] },
          { id: "old-b", content: "Cancelled", status: "cancelled", deps: [] },
          { id: "old-c", content: "Failed", status: "failed", deps: [] },
        ]
        const result = Dag.validate([{ id: "fresh", content: "Fresh start", status: "pending", deps: [] }], previous)
        expect(result.valid).toBe(true)
        expect(result.warnings.length).toBe(0)
      }))

    test("still warns when previous DAG is terminal but IDs overlap", () =>
      runtime.run(() => {
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
      }))

    test("warns on changing completed node status", () =>
      runtime.run(() => {
        const previous: Dag.Node[] = [{ id: "a", content: "Done", status: "completed", deps: [] }]
        const result = Dag.validate([{ id: "a", content: "Done", status: "pending", deps: [] }], previous)
        expect(result.valid).toBe(true)
        expect(result.warnings.some((w) => w.includes("completed node") && w.includes("changed"))).toBe(true)
      }))

    test("warns on dropping running nodes", () =>
      runtime.run(() => {
        const previous: Dag.Node[] = [
          { id: "a", content: "Running", status: "running", deps: [] },
          { id: "b", content: "Other", status: "pending", deps: ["a"] },
        ]
        const result = Dag.validate([{ id: "b", content: "Other", status: "pending", deps: [] }], previous)
        expect(result.warnings.some((w) => w.includes("Running node") && w.includes("dropped"))).toBe(true)
      }))

    test("warns on unusual status transition", () =>
      runtime.run(() => {
        const previous: Dag.Node[] = [{ id: "a", content: "Task", status: "pending", deps: [] }]
        const result = Dag.validate([{ id: "a", content: "Task", status: "completed", deps: [] }], previous)
        expect(result.valid).toBe(true)
        expect(result.warnings.some((w) => w.includes("Unusual status transition"))).toBe(true)
      }))

    test("allows valid status transition", () =>
      runtime.run(() => {
        const previous: Dag.Node[] = [{ id: "a", content: "Task", status: "pending", deps: [] }]
        const result = Dag.validate([{ id: "a", content: "Task", status: "running", deps: [] }], previous)
        expect(result.valid).toBe(true)
        expect(result.warnings.length).toBe(0)
      }))

    test("allows retry: failed → pending", () =>
      runtime.run(() => {
        const previous: Dag.Node[] = [{ id: "a", content: "Task", status: "failed", deps: [] }]
        const result = Dag.validate([{ id: "a", content: "Task (revised)", status: "pending", deps: [] }], previous)
        expect(result.valid).toBe(true)
        expect(result.warnings.length).toBe(0)
      }))

    test("allows blocked → pending", () =>
      runtime.run(() => {
        const previous: Dag.Node[] = [{ id: "a", content: "Task", status: "blocked", deps: [] }]
        const result = Dag.validate([{ id: "a", content: "Task", status: "pending", deps: [] }], previous)
        expect(result.valid).toBe(true)
        expect(result.warnings.length).toBe(0)
      }))

    test("preserves optional task binding and memo fields", () =>
      runtime.run(() => {
        const result = Dag.validate([
          {
            id: "a",
            content: "Task",
            status: "blocked",
            deps: [],
            task_id: "ctx_01234567890abcdef",
            session_id: "ses_01234567890abcdef",
            memo: "Needs user decision",
          },
        ])
        expect(result.valid).toBe(true)
        expect(result.nodes[0].task_id).toBe("ctx_01234567890abcdef")
        expect(result.nodes[0].session_id).toBe("ses_01234567890abcdef")
        expect(result.nodes[0].memo).toBe("Needs user decision")
      }))

    test("warns on modified completed node content", () =>
      runtime.run(() => {
        const previous: Dag.Node[] = [{ id: "a", content: "Original", status: "completed", deps: [] }]
        const result = Dag.validate([{ id: "a", content: "Modified", status: "completed", deps: [] }], previous)
        expect(result.valid).toBe(true)
        expect(result.warnings.some((w) => w.includes("Content of completed node"))).toBe(true)
      }))
  })

  describe("Layer 6: Semantic warnings", () => {
    test("warns when running node has non-completed deps", () =>
      runtime.run(() => {
        const result = Dag.validate([
          { id: "a", content: "A", status: "pending", deps: [] },
          { id: "b", content: "B", status: "running", deps: ["a"] },
        ])
        expect(result.valid).toBe(true)
        expect(result.warnings.some((w) => w.includes("running") && w.includes("dep"))).toBe(true)
      }))

    test("warns when pending node depends on failed node", () =>
      runtime.run(() => {
        const result = Dag.validate([
          { id: "a", content: "A", status: "failed", deps: [] },
          { id: "b", content: "B", status: "pending", deps: ["a"] },
        ])
        expect(result.valid).toBe(true)
        expect(result.warnings.some((w) => w.includes("never become ready"))).toBe(true)
      }))

    test("warns when pending node depends on blocked node", () =>
      runtime.run(() => {
        const result = Dag.validate([
          { id: "a", content: "A", status: "blocked", deps: [] },
          { id: "b", content: "B", status: "pending", deps: ["a"] },
        ])
        expect(result.valid).toBe(true)
        expect(result.warnings.some((w) => w.includes("blocked") && w.includes("never become ready"))).toBe(true)
      }))

    test("warns when no root nodes", () =>
      runtime.run(() => {
        const result = Dag.validate([
          { id: "a", content: "A", status: "pending", deps: ["b"] },
          { id: "b", content: "B", status: "pending", deps: ["a"] },
        ])
        // This will actually be caught by cycle detection first
        expect(result.valid).toBe(false)
      }))
  })

  describe("Empty DAG", () => {
    test("rejects empty node list", () =>
      runtime.run(() => {
        const result = Dag.validate([])
        expect(result.valid).toBe(false)
        expect(result.errors[0]).toContain("empty")
      }))
  })

  describe("No previous DAG (first creation)", () => {
    test("works without previous DAG", () =>
      runtime.run(() => {
        const result = Dag.validate([
          { id: "a", content: "A", status: "pending", deps: [] },
          { id: "b", content: "B", status: "pending", deps: ["a"] },
        ])
        expect(result.valid).toBe(true)
        expect(result.errors.length).toBe(0)
      }))
  })
})

describe("Dag.computeReady", () => {
  test("identifies root pending nodes as ready", () =>
    runtime.run(() => {
      const ready = Dag.computeReady([
        { id: "a", content: "A", status: "pending", deps: [] },
        { id: "b", content: "B", status: "pending", deps: ["a"] },
      ])
      expect(ready).toEqual(["a"])
    }))

  test("identifies nodes with all completed deps as ready", () =>
    runtime.run(() => {
      const ready = Dag.computeReady([
        { id: "a", content: "A", status: "completed", deps: [] },
        { id: "b", content: "B", status: "completed", deps: [] },
        { id: "c", content: "C", status: "pending", deps: ["a", "b"] },
      ])
      expect(ready).toEqual(["c"])
    }))

  test("does not mark running nodes as ready", () =>
    runtime.run(() => {
      const ready = Dag.computeReady([
        { id: "a", content: "A", status: "completed", deps: [] },
        { id: "b", content: "B", status: "running", deps: ["a"] },
      ])
      expect(ready).toEqual([])
    }))

  test("returns empty for empty DAG", () =>
    runtime.run(() => {
      expect(Dag.computeReady([])).toEqual([])
    }))
})

describe("Dag.get", () => {
  test("preserves the missing session error", () =>
    runtime.run(async () => {
      const sessionID = Identifier.ascending("session")
      const error = await Dag.get(sessionID).catch((cause) => cause)

      expect(error).toBeInstanceOf(Storage.NotFoundError)
      expect(error).toMatchObject({ data: { message: `Session ${sessionID} not found` } })
    }))
})

afterRuntimeTests(() => runtime.close())
