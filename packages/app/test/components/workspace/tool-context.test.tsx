import { describe, expect, test } from "bun:test"
import { createContextWorkbenchPanel } from "../../../src/components/workspace/context-panel-entry"
import { isWorkbenchPanelAvailable } from "@/context/workbench/panel-model"

const panel = createContextWorkbenchPanel("本地化上下文")

describe("Context workbench registration", () => {
  test("injects a localized label into the lazy session-scoped side singleton", () => {
    expect(panel).toMatchObject({
      id: "context",
      label: "本地化上下文",
      surface: "side",
      cardinality: "singleton",
      requiresSession: true,
      pluginId: "builtin",
      order: 12,
    })
    expect(typeof panel.loader).toBe("function")
    expect(typeof panel.title).toBe("function")
  })

  test("is unavailable before a session exists", () => {
    expect(isWorkbenchPanelAvailable(panel, false)).toBe(false)
    expect(isWorkbenchPanelAvailable(panel, true)).toBe(true)
  })
})
