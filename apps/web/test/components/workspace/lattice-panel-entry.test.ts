import { describe, expect, test } from "bun:test"
import { createLatticeWorkbenchPanel } from "../../../src/components/workspace/lattice-panel-entry"

describe("Lattice workbench panel", () => {
  test("registers as one lazy session-scoped side Workspace tab", () => {
    const panel = createLatticeWorkbenchPanel("Lattice")

    expect(panel).toMatchObject({
      id: "lattice",
      label: "Lattice",
      surface: "side",
      cardinality: "singleton",
      requiresSession: true,
      pluginId: "builtin",
    })
    expect(panel.loader).toBeFunction()
    expect(panel.component).toBeUndefined()
  })
})
