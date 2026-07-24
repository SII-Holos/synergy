import { describe, expect, test } from "bun:test"
import { ToolTaxonomy } from "../../src/tool/taxonomy"

describe("tool taxonomy", () => {
  test("classifies render as a visual communication tool", () => {
    const entry = ToolTaxonomy.classify("render")

    expect(entry.kind).toBe("communication.visual")
    expect(entry.domain).toBe("communication")
  })

  test("classifies render-like custom tools as visual communication tools", () => {
    const entry = ToolTaxonomy.classify("render_chart")

    expect(entry.kind).toBe("communication.visual")
    expect(entry.domain).toBe("communication")
  })

  test("classifies Lattice reads and writes by their durable behavior", () => {
    expect(ToolTaxonomy.classify("pathway_read")).toMatchObject({
      kind: "orchestration.dag",
      traits: { auxiliary: true },
    })
    expect(ToolTaxonomy.classify("pathway_write")).toMatchObject({
      kind: "orchestration.dag",
      traits: { auxiliary: true, stateful: true },
    })
    expect(ToolTaxonomy.classify("lattice_submit")).toMatchObject({
      kind: "orchestration.task",
      traits: { auxiliary: true, stateful: true },
    })
  })
})
