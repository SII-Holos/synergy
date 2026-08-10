import { describe, expect, test } from "bun:test"
import { createBossWorkbenchPanel } from "../../../src/components/workspace/boss-panel-entry"

describe("Boss workbench panel", () => {
  test("registers as one lazy session-scoped side Workspace tab", () => {
    const panel = createBossWorkbenchPanel("Boss")

    expect(panel).toMatchObject({
      id: "boss",
      label: "Boss",
      surface: "side",
      cardinality: "singleton",
      requiresSession: true,
      pluginId: "builtin",
    })
    expect(panel.loader).toBeFunction()
    expect(panel.component).toBeUndefined()
  })
})
