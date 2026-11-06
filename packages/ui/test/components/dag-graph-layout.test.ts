import { describe, expect, test } from "bun:test"
import { computeLayout, focusTargets, type DagNode } from "../../src/components/dag-graph-layout"

const node = (id: string, status: string, deps: string[], content = id): DagNode => ({ id, status, deps, content })

const graph = [
  node("root", "running", []),
  node("a", "pending", ["root"]),
  node("b", "pending", ["root"]),
  node("c", "pending", ["root"]),
  node("d", "pending", ["a", "b"]),
  node("e", "pending", ["d"]),
]

describe("computeLayout", () => {
  test("uses measured card heights instead of the character estimate", () => {
    const measured = new Map([
      ["root", 132],
      ["a", 108],
      ["b", 168],
      ["c", 108],
      ["d", 108],
      ["e", 108],
    ])
    const layout = computeLayout(graph, 640, (item) => measured.get(item.id))
    expect(layout.laid.find((item) => item.node.id === "b")?.h).toBe(168)
    expect(layout.laid.find((item) => item.node.id === "root")?.h).toBe(132)
  })

  test("keeps a floor when no measurement exists yet", () => {
    const layout = computeLayout(graph, 640)
    for (const item of layout.laid) expect(item.h).toBeGreaterThanOrEqual(108)
  })

  test("a taller card pushes later layers down", () => {
    const short = computeLayout(graph, 640, () => 108)
    const tall = computeLayout(graph, 640, () => 240)
    const offset = (layout: ReturnType<typeof computeLayout>) => layout.laid.find((item) => item.node.id === "e")!.y
    expect(offset(tall)).toBeGreaterThan(offset(short))
  })
})

describe("focusTargets", () => {
  const layout = computeLayout(graph, 640, () => 108)
  const byId = (id: string) => layout.laid.find((item) => item.node.id === id)!

  test("frames the active card with its layer siblings", () => {
    const targets = focusTargets(layout.laid, [byId("root")]).map((item) => item.node.id)
    expect(targets).toContain("root")
    expect(targets).toContain("a")
    expect(targets).toContain("b")
    expect(targets).toContain("c")
  })

  test("adds exactly one level of children and stops", () => {
    const targets = focusTargets(layout.laid, [byId("a")]).map((item) => item.node.id)
    expect(targets).toContain("d")
    expect(targets).not.toContain("e")
  })

  test("a root seed frames its own row plus the next row only", () => {
    const targets = focusTargets(layout.laid, [byId("root")]).map((item) => item.node.id)
    expect(targets.sort()).toEqual(["a", "b", "c", "root"])
  })

  test("frames parallel siblings of the active card's layer", () => {
    const targets = focusTargets(layout.laid, [byId("a")]).map((item) => item.node.id)
    expect(["a", "b", "c"].every((id) => targets.includes(id))).toBe(true)
  })

  test("falls back to the leading cards when nothing is active", () => {
    expect(focusTargets(layout.laid, []).length).toBeGreaterThan(0)
  })
})
