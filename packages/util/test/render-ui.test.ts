import { expect, test } from "bun:test"
import { RenderUI } from "../src/render-ui"

const spec = {
  state: { seats: 8 },
  computed: [{ id: "price", op: "multiply", inputs: [{ ref: "seats" }, 29] }],
  nodes: [
    { id: "seats-control", type: "slider", label: "Seats", state: "seats", min: 1, max: 50 },
    { id: "price-output", type: "metric", label: "Monthly price", value: { ref: "price" }, prefix: "$" },
  ],
}

test("catalog validates references and derives values without executing authored code", () => {
  const parsed = RenderUI.Spec.parse(spec)
  expect(RenderUI.evaluate(parsed, { seats: 9 }).price).toBe(261)
  expect(RenderUI.Spec.safeParse({ ...spec, state: { constructor: 1 } }).success).toBe(false)
  expect(RenderUI.Spec.safeParse({ ...spec, nodes: [...spec.nodes, spec.nodes[0]] }).success).toBe(false)
  expect(RenderUI.Spec.safeParse({ ...spec, nodes: [{ ...spec.nodes[0], onChange: "alert(1)" }] }).success).toBe(false)
  expect(
    RenderUI.Spec.safeParse({ ...spec, computed: [{ id: "price", op: "multiply", inputs: [{ ref: "missing" }, 29] }] })
      .success,
  ).toBe(false)
  expect(RenderUI.Spec.safeParse({ ...spec, nodes: [{ id: "cycle", type: "card", parent: "cycle" }] }).success).toBe(
    false,
  )
})

test("stream projection retains validated nodes and defers incomplete tail and dependencies", () => {
  const projected = RenderUI.preview({ ...spec, nodes: [...spec.nodes, { id: "pending", type: "metric" }] })
  expect(projected?.nodes).toHaveLength(2)
  expect(
    RenderUI.preview({
      state: { seats: 8 },
      nodes: [{ id: "future", type: "metric", label: "Price", value: { ref: "price" } }],
    }),
  ).toBeUndefined()
})

test("arithmetic failures are explicit and fallback includes computed initial content as escaped text", () => {
  const parsed = RenderUI.Spec.parse(spec)
  const bad = RenderUI.Spec.parse({ ...spec, computed: [{ id: "price", op: "divide", inputs: [1, { ref: "seats" }] }] })
  expect(() => RenderUI.evaluate(bad, { seats: 0 })).toThrow("price")
  expect(RenderUI.fallback(parsed)).toContain("$232")
  expect(
    RenderUI.fallback(RenderUI.Spec.parse({ nodes: [{ id: "x", type: "text", text: "<script>alert(1)</script>" }] })),
  ).not.toContain("<script>")
})

test("catalog rejects nonnumeric computation and chart bindings before storing an unusable source", () => {
  for (const binding of ["N/A", true, { ref: "label" }]) {
    expect(
      RenderUI.Spec.safeParse({
        state: { label: "N/A" },
        nodes: [{ id: "bar", type: "bar", label: "Comparison", items: [{ label: "Current", value: binding }] }],
      }).success,
    ).toBe(false)
    expect(
      RenderUI.Spec.safeParse({
        state: { label: "N/A" },
        computed: [{ id: "total", op: "add", inputs: [binding, 1] }],
        nodes: [{ id: "total", type: "metric", label: "Total", value: { ref: "total" } }],
      }).success,
    ).toBe(false)
  }
  const numeric = RenderUI.Spec.parse({
    state: { base: 2 },
    computed: [
      { id: "subtotal", op: "add", inputs: [{ ref: "base" }, 3] },
      { id: "total", op: "multiply", inputs: [{ ref: "subtotal" }, 4] },
    ],
    nodes: [{ id: "bar", type: "bar", label: "Comparison", items: [{ label: "Current", value: { ref: "total" } }] }],
  })
  expect(RenderUI.evaluate(numeric, numeric.state).total).toBe(20)
})
