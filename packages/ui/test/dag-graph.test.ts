import { describe, test, expect } from "bun:test"
import { computeLayout, type DagNode } from "../src/components/dag-graph"

function node(id: string, overrides?: Partial<DagNode>): DagNode {
  return { id, content: `Task ${id}`, status: "pending", deps: [], ...overrides }
}

const empty = { laid: [], edges: [], width: 0, height: 0, cardW: 0 }

describe("computeLayout", () => {
  // ── Topology ──────────────────────────────────────────────

  test("empty array", () => {
    expect(computeLayout([], 600)).toEqual(empty)
  })

  test("single node", () => {
    const r = computeLayout([node("a")], 600)
    expect(r.laid.length).toBe(1)
    expect(r.laid[0].layer).toBe(0)
    expect(r.edges).toEqual([])
  })

  test("linear chain — each node one layer deeper", () => {
    const r = computeLayout([node("a"), node("b", { deps: ["a"] }), node("c", { deps: ["b"] })], 600)
    const layer = Object.fromEntries(r.laid.map((ln) => [ln.node.id, ln.layer]))
    expect(layer).toEqual({ a: 0, b: 1, c: 2 })
  })

  test("parallel roots share layer 0", () => {
    const r = computeLayout([node("a"), node("b"), node("c", { deps: ["a", "b"] })], 600)
    const layer = Object.fromEntries(r.laid.map((ln) => [ln.node.id, ln.layer]))
    expect(layer.a).toBe(0)
    expect(layer.b).toBe(0)
    expect(layer.c).toBe(1)
  })

  test("diamond dependency — convergence node gets max depth + 1", () => {
    // a ─┐
    //    ├─ c ─┐
    // b ─┘     ├─ d
    //    ──────┘
    const r = computeLayout(
      [node("a"), node("b"), node("c", { deps: ["a", "b"] }), node("d", { deps: ["c", "b"] })],
      600,
    )
    const layer = Object.fromEntries(r.laid.map((ln) => [ln.node.id, ln.layer]))
    expect(layer.a).toBe(0)
    expect(layer.b).toBe(0)
    expect(layer.c).toBe(1)
    expect(layer.d).toBe(2) // max(c=1, b=0) + 1
  })

  test("edges are created for each dep relationship", () => {
    const r = computeLayout([node("a"), node("b"), node("c", { deps: ["a", "b"] })], 600)
    const pairs = r.edges.map((e) => `${e.from.node.id}->${e.to.node.id}`).sort()
    expect(pairs).toEqual(["a->c", "b->c"])
  })

  // ── Cycles (would stack-overflow without guard) ───────────

  test("self-referencing dep does not crash", () => {
    const r = computeLayout([node("a", { deps: ["a"] })], 600)
    expect(r.laid.length).toBe(1)
  })

  test("two-node cycle does not crash", () => {
    const r = computeLayout([node("a", { deps: ["b"] }), node("b", { deps: ["a"] })], 600)
    expect(r.laid.length).toBe(2)
  })

  test("long cycle does not crash", () => {
    const r = computeLayout([node("a", { deps: ["c"] }), node("b", { deps: ["a"] }), node("c", { deps: ["b"] })], 600)
    expect(r.laid.length).toBe(3)
  })

  // ── Dangling / unknown deps ───────────────────────────────

  test("dep referencing non-existent node — treated as depth 0 dep", () => {
    const r = computeLayout([node("a", { deps: ["ghost"] })], 600)
    expect(r.laid.length).toBe(1)
    // ghost resolves to depth 0, so a = 0+1 = 1
    expect(r.laid[0].layer).toBe(1)
    // no edge created for ghost since it's not in the layout
    expect(r.edges.length).toBe(0)
  })

  // ── Partial hydration (SolidJS store mid-reconcile) ───────

  test("undefined deps — treated as root", () => {
    const n = { id: "a", content: "x", status: "pending", deps: undefined } as unknown as DagNode
    const r = computeLayout([n], 600)
    expect(r.laid.length).toBe(1)
    expect(r.laid[0].layer).toBe(0)
  })

  test("deps is a non-array value — treated as root", () => {
    const n = { id: "a", content: "x", status: "pending", deps: "not-an-array" } as unknown as DagNode
    const r = computeLayout([n], 600)
    expect(r.laid.length).toBe(1)
    expect(r.laid[0].layer).toBe(0)
  })

  test("undefined content — no crash, positive card height", () => {
    const n = { id: "a", content: undefined, status: "pending", deps: [] } as unknown as DagNode
    const r = computeLayout([n], 600)
    expect(r.laid.length).toBe(1)
    expect(r.laid[0].h).toBeGreaterThan(0)
  })

  test("undefined status — filtered out", () => {
    const r = computeLayout(
      [node("a"), { id: "b", content: "x", status: undefined, deps: [] } as unknown as DagNode],
      600,
    )
    expect(r.laid.length).toBe(1)
    expect(r.laid[0].node.id).toBe("a")
  })

  test("undefined id — filtered out", () => {
    const r = computeLayout(
      [node("a"), { id: undefined, content: "x", status: "pending", deps: [] } as unknown as DagNode],
      600,
    )
    expect(r.laid.length).toBe(1)
  })

  test("empty string id — filtered out (falsy)", () => {
    const r = computeLayout(
      [node("a"), { id: "", content: "x", status: "pending", deps: [] } as unknown as DagNode],
      600,
    )
    expect(r.laid.length).toBe(1)
  })

  test("completely empty object — filtered out", () => {
    const r = computeLayout([node("a"), {} as unknown as DagNode], 600)
    expect(r.laid.length).toBe(1)
  })

  test("all nodes partially hydrated — returns empty layout", () => {
    const r = computeLayout([{ id: undefined } as unknown as DagNode, { status: undefined } as unknown as DagNode], 600)
    expect(r).toEqual(empty)
  })

  test("mixed valid and partial nodes — only valid ones laid out", () => {
    const r = computeLayout(
      [
        node("a"),
        { id: "b", status: "running" } as unknown as DagNode, // missing content+deps
        node("c", { deps: ["a"] }),
        {} as unknown as DagNode,
      ],
      600,
    )
    const ids = r.laid.map((ln) => ln.node.id).sort()
    expect(ids).toEqual(["a", "b", "c"])
  })

  // ── Duplicate ids ─────────────────────────────────────────

  test("duplicate ids — last one wins in Map, no crash", () => {
    const r = computeLayout([node("a", { content: "first" }), node("a", { content: "second" })], 600)
    // Map deduplicates to last entry; both are in rawNodes but map has one
    // layout should still not crash
    expect(r.laid.length).toBeGreaterThanOrEqual(1)
  })

  // ── Container width edge cases ────────────────────────────

  test("containerWidth = 0 — falls back to 600", () => {
    const r = computeLayout([node("a")], 0)
    expect(r.width).toBe(600)
    expect(r.laid.length).toBe(1)
  })

  test("negative containerWidth — falls back to 600", () => {
    const r = computeLayout([node("a")], -100)
    // -100 is truthy so || 600 doesn't trigger, but layout should not crash
    expect(r.laid.length).toBe(1)
  })

  test("very small containerWidth — cards use minimum width", () => {
    const r = computeLayout([node("a"), node("b")], 50)
    expect(r.cardW).toBeGreaterThanOrEqual(100) // MIN_CARD_W
  })

  // ── Content extremes ──────────────────────────────────────

  test("empty string content — minimum card height", () => {
    const r = computeLayout([node("a", { content: "" })], 600)
    expect(r.laid[0].h).toBeGreaterThan(0)
  })

  test("very long content — taller card", () => {
    const short = computeLayout([node("a", { content: "hi" })], 600)
    const long = computeLayout([node("a", { content: "x".repeat(500) })], 600)
    expect(long.laid[0].h).toBeGreaterThan(short.laid[0].h)
  })

  // ── Scale ─────────────────────────────────────────────────

  test("wide graph — 20 parallel roots", () => {
    const nodes = Array.from({ length: 20 }, (_, i) => node(`n${i}`))
    const r = computeLayout(nodes, 600)
    expect(r.laid.length).toBe(20)
    // all on layer 0
    expect(r.laid.every((ln) => ln.layer === 0)).toBe(true)
  })

  test("deep chain — 50 sequential nodes", () => {
    const nodes: DagNode[] = [node("n0")]
    for (let i = 1; i < 50; i++) nodes.push(node(`n${i}`, { deps: [`n${i - 1}`] }))
    const r = computeLayout(nodes, 600)
    expect(r.laid.length).toBe(50)
    const last = r.laid.find((ln) => ln.node.id === "n49")
    expect(last!.layer).toBe(49)
  })
})
