import { expect, test } from "bun:test"
import { applyProjectionPatch, projectionPatch } from "../src/projection-patch"

test("incremental fields and array edits reconstruct authority without repeating unchanged context", () => {
  const context = "long context ".repeat(10000)
  const previous = {
    context,
    nodes: [
      { id: "a", status: "running" },
      { id: "b", status: "done" },
    ],
    old: true,
  }
  const next = {
    context,
    nodes: [
      { id: "a", status: "done" },
      { id: "c", status: "running" },
      { id: "d", status: "done" },
    ],
  }
  const patch = projectionPatch(previous, next)
  expect(JSON.stringify(patch).length).toBeLessThan(512)
  expect(applyProjectionPatch(previous, patch)).toEqual(next)
  expect(previous.nodes[0].status).toBe("running")
  const retained = { unchanged: { text: context }, changing: { value: 1 } }
  const updated = applyProjectionPatch(retained, [{ path: ["changing", "value"], value: 2 }]) as typeof retained
  expect(updated.unchanged).toBe(retained.unchanged)
  expect(retained.changing.value).toBe(1)
  expect(applyProjectionPatch(next, projectionPatch(next, { context, nodes: [] }))).toEqual({ context, nodes: [] })
})

test("malformed paths cannot escape the snapshot or mutate prototype state", () => {
  expect(() => applyProjectionPatch({}, [{ path: ["__proto__", "polluted"], value: true }])).toThrow()
  expect(() => applyProjectionPatch({}, [{ path: ["missing", "child"], value: true }])).toThrow()
})
