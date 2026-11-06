import { describe, expect, test } from "bun:test"
import { ToolTaxonomy } from "../../src/tool/taxonomy"

describe("tool taxonomy", () => {
  test("classifies worktree archive as stateful workspace configuration", () => {
    expect(ToolTaxonomy.classify("worktree_archive")).toEqual({
      kind: "platform.config",
      domain: "platform",
      traits: { stateful: true },
    })
  })

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

  test("classifies resolve_conflicts as a stateful code write", () => {
    expect(ToolTaxonomy.classify("resolve_conflicts")).toEqual({
      kind: "code.write",
      domain: "code",
      traits: { stateful: true },
    })
  })

  test("classifies response_card as stateful external Channel delivery", () => {
    expect(ToolTaxonomy.classify("response_card")).toEqual({
      kind: "communication.deliver",
      domain: "communication",
      traits: { stateful: true, externalIO: true },
    })
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

  test("keeps current collaboration tools classified and retired tools generic", () => {
    const entry = ToolTaxonomy.classify("github_deliver_fix")

    expect(entry.kind).toBe("platform.collaboration")
    expect(entry.traits).toEqual({ stateful: true, externalIO: true })
    expect(ToolTaxonomy.classify("clarus_submit_task_result").kind).toBe("platform.external")
  })

  test("labels collaboration tools without a retired product name", () => {
    expect(ToolTaxonomy.KIND_LABELS["platform.collaboration"]).toBe("Collaboration")
  })
})
