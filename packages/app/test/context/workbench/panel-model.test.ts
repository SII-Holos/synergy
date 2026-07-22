import { describe, expect, test } from "bun:test"
import {
  closeWorkbenchPanelTab,
  moveWorkbenchPanelTab,
  openWorkbenchPanelTab,
  resolveWorkbenchEscapeAction,
  updateWorkbenchPanelTab,
} from "../../../src/context/workbench/panel-model"

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

  test("multi panels reuse the same resource without changing its position", () => {
    const tabs = [
      { id: "file:a", panelId: "file", resourceId: "src/a.ts", title: "a.ts" },
      { id: "notes", panelId: "notes" },
    ]
    const result = openWorkbenchPanelTab({
      panelId: "file",
      cardinality: "multi",
      tabs,
      init: { resourceId: "src/a.ts", title: "a.ts · src" },
      createId: () => "file:duplicate",
    })

    expect(result.tabs).toEqual([
      { id: "file:a", panelId: "file", resourceId: "src/a.ts", title: "a.ts · src" },
      { id: "notes", panelId: "notes" },
    ])
    expect(result.active).toBe("file:a")
    expect(result.created).toBeUndefined()
  })

  test("resource tabs preserve opaque plugin state and keep distinct resources separate", () => {
    const first = openWorkbenchPanelTab({
      panelId: "plugin:truthward:research-map",
      cardinality: "multi",
      tabs: [],
      init: { resourceId: "map", title: "Research map", state: { view: "map" } },
      createId: () => "map-tab",
    })
    const second = openWorkbenchPanelTab({
      panelId: "plugin:truthward:research-map",
      cardinality: "multi",
      tabs: first.tabs,
      init: {
        resourceId: "node:N01_InterpretResearchIntent",
        title: "Interpret research intent",
        state: { view: "node", nodeID: "N01_InterpretResearchIntent" },
      },
      createId: () => "node-tab",
    })

    expect(second.tabs).toEqual([
      {
        id: "map-tab",
        panelId: "plugin:truthward:research-map",
        resourceId: "map",
        title: "Research map",
        state: { view: "map" },
      },
      {
        id: "node-tab",
        panelId: "plugin:truthward:research-map",
        resourceId: "node:N01_InterpretResearchIntent",
        title: "Interpret research intent",
        state: { view: "node", nodeID: "N01_InterpretResearchIntent" },
      },
    ])
  })

  test("resource panels can replace an empty tab in place", () => {
    const tabs = [
      { id: "file:empty", panelId: "file", title: "Open file" },
      { id: "notes", panelId: "notes" },
    ]
    const result = openWorkbenchPanelTab({
      panelId: "file",
      cardinality: "multi",
      tabs,
      init: { resourceId: "src/app.ts", title: "app.ts", source: "workspace" },
      createId: () => "file:new",
      replaceEmpty: true,
    })

    expect(result.tabs).toEqual([
      { id: "file:empty", panelId: "file", resourceId: "src/app.ts", title: "app.ts", source: "workspace" },
      { id: "notes", panelId: "notes" },
    ])
    expect(result.active).toBe("file:empty")
    expect(result.created).toBeUndefined()
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

describe("workbench tab updates", () => {
  test("updates a tab in place and preserves its identity", () => {
    const tabs = [{ id: "file:a", panelId: "file", resourceId: "old.ts", title: "old.ts" }]
    const result = updateWorkbenchPanelTab(tabs, "file:a", {
      resourceId: "src/new.ts",
      title: "new.ts",
    })

    expect(result).toEqual([{ id: "file:a", panelId: "file", resourceId: "src/new.ts", title: "new.ts" }])
  })

  test("moves a tab to the requested stable index", () => {
    const tabs = [
      { id: "a", panelId: "file" },
      { id: "b", panelId: "file" },
      { id: "c", panelId: "notes" },
    ]
    expect(moveWorkbenchPanelTab(tabs, "a", 2).map((tab) => tab.id)).toEqual(["b", "c", "a"])
  })
})

describe("workbench Escape routing", () => {
  test("keeps the workspace open while a nested dialog owns Escape", () => {
    expect(
      resolveWorkbenchEscapeAction({
        key: "Escape",
        opened: true,
        addOpen: false,
        dialogActive: true,
      }),
    ).toBe("none")
  })

  test("closes the add menu before the workspace and ignores unrelated keys", () => {
    expect(resolveWorkbenchEscapeAction({ key: "Escape", opened: true, addOpen: true, dialogActive: false })).toBe(
      "close-add-menu",
    )
    expect(resolveWorkbenchEscapeAction({ key: "Escape", opened: true, addOpen: false, dialogActive: false })).toBe(
      "close-surface",
    )
    expect(resolveWorkbenchEscapeAction({ key: "Enter", opened: true, addOpen: false, dialogActive: false })).toBe(
      "none",
    )
  })
})
