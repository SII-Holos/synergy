import { describe, expect, test } from "bun:test"
import { closeWorkbenchPanelTab, openWorkbenchPanelTab } from "./workbench-panels-model"

describe("openWorkbenchPanelTab", () => {
  test("exclusive panels replace existing tabs", () => {
    const result = openWorkbenchPanelTab({
      panelId: "notes",
      cardinality: "exclusive",
      tabs: [{ id: "browser", panelId: "browser" }],
      createId: () => "notes-tab",
    })

    expect(result.tabs).toEqual([{ id: "notes-tab", panelId: "notes" }])
    expect(result.active).toBe("notes-tab")
  })

  test("singleton panels reuse an existing tab", () => {
    const tabs = [{ id: "notes-tab", panelId: "notes" }]
    const result = openWorkbenchPanelTab({
      panelId: "notes",
      cardinality: "singleton",
      tabs,
      createId: () => "new-notes-tab",
    })

    expect(result.tabs).toBe(tabs)
    expect(result.active).toBe("notes-tab")
  })

  test("singleton panels update an existing tab target when init is provided", () => {
    const tabs = [{ id: "notes-tab", panelId: "notes", resourceId: "note_old", source: "home" }]
    const result = openWorkbenchPanelTab({
      panelId: "notes",
      cardinality: "singleton",
      tabs,
      init: { resourceId: "note_blueprint", title: "Blueprint plan", source: "C:/repo/main" },
      createId: () => "new-notes-tab",
    })

    expect(result.tabs).toEqual([
      {
        id: "notes-tab",
        panelId: "notes",
        resourceId: "note_blueprint",
        title: "Blueprint plan",
        source: "C:/repo/main",
      },
    ])
    expect(result.active).toBe("notes-tab")
  })

  test("different singleton panels can coexist", () => {
    const result = openWorkbenchPanelTab({
      panelId: "browser",
      cardinality: "singleton",
      tabs: [{ id: "notes-tab", panelId: "notes" }],
      createId: () => "browser-tab",
    })

    expect(result.tabs).toEqual([
      { id: "notes-tab", panelId: "notes" },
      { id: "browser-tab", panelId: "browser" },
    ])
    expect(result.active).toBe("browser-tab")
  })

  test("multi panels create new tabs unless reuse is requested", () => {
    const tabs = [{ id: "terminal:1", panelId: "terminal", resourceId: "pty-1" }]
    const created = openWorkbenchPanelTab({
      panelId: "terminal",
      cardinality: "multi",
      tabs,
      init: { resourceId: "pty-2" },
      createId: () => "terminal:2",
    })

    expect(created.tabs).toHaveLength(2)
    expect(created.active).toBe("terminal:2")

    const reused = openWorkbenchPanelTab({
      panelId: "terminal",
      cardinality: "multi",
      tabs: created.tabs,
      createId: () => "terminal:3",
      reuseExisting: true,
    })

    expect(reused.tabs).toBe(created.tabs)
    expect(reused.active).toBe("terminal:1")
  })
})

describe("closeWorkbenchPanelTab", () => {
  test("activates a neighboring tab when the active tab closes", () => {
    const result = closeWorkbenchPanelTab(
      [
        { id: "a", panelId: "terminal" },
        { id: "b", panelId: "terminal" },
      ],
      "b",
      "b",
    )

    expect(result.tabs).toEqual([{ id: "a", panelId: "terminal" }])
    expect(result.active).toBe("a")
  })

  test("returns to launcher when the last tab closes", () => {
    const result = closeWorkbenchPanelTab([{ id: "a", panelId: "notes" }], "a", "a")

    expect(result.tabs).toEqual([])
    expect(result.active).toBeUndefined()
  })
})
