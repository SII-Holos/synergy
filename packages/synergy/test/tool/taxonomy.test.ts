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

  test("classifies workflow tools as orchestration with exact stateful traits", () => {
    expect(ToolTaxonomy.classify("workflow_status")).toEqual({
      kind: "orchestration.workflow",
      domain: "orchestration",
      traits: {},
    })

    for (const toolName of [
      "workflow_run_create",
      "workflow_run_control",
      "workflow_entity_add",
      "workflow_entity_unblock",
      "workflow_gate_resolve",
      "workflow_submit",
      "workflow_block",
      "workflow_charter_draft",
    ]) {
      expect(ToolTaxonomy.classify(toolName)).toEqual({
        kind: "orchestration.workflow",
        domain: "orchestration",
        traits: { stateful: true },
      })
    }
  })
})
