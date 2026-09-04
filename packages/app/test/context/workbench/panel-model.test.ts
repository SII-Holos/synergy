import { describe, expect, test } from "bun:test"
import type { WorkbenchPanelTab } from "../../../src/plugin/registries/workbench-panel-registry"
import {
  anyWorkbenchEscapeMenuOpen,
  closeAllWorkbenchEscapeMenus,
  closeOtherWorkbenchPanelTabs,
  closeWorkbenchPanelTab,
  isEditableEscapeTarget,
  isWorkbenchPanelLaunchable,
  moveWorkbenchPanelTab,
  openWorkbenchPanelTab,
  registerWorkbenchEscapeMenu,
  resolveWorkbenchEscapeAction,
  updateWorkbenchPanelTab,
  workbenchPanelMountKey,
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

describe("closeOtherWorkbenchPanelTabs", () => {
  test("keeps only the requested tab and activates it", () => {
    const tabs = [
      { id: "file:a", panelId: "file", resourceId: "src/a.ts", title: "a.ts" },
      { id: "notes", panelId: "notes" },
      { id: "file:b", panelId: "file", resourceId: "src/b.ts", title: "b.ts" },
    ]
    const result = closeOtherWorkbenchPanelTabs(tabs, "file:a", "notes")

    expect(result.tabs).toEqual([{ id: "notes", panelId: "notes" }])
    expect(result.active).toBe("notes")
  })

  test("activates the kept tab even when another tab was active", () => {
    const tabs = [
      { id: "a", panelId: "file" },
      { id: "b", panelId: "file" },
    ]
    const result = closeOtherWorkbenchPanelTabs(tabs, "b", "a")

    expect(result.active).toBe("a")
  })

  test("preserves opaque tab state on the kept tab", () => {
    const tabs = [
      { id: "map", panelId: "plugin:research-map", resourceId: "map", state: { view: "map" } },
      { id: "node", panelId: "plugin:research-map" },
    ]
    const result = closeOtherWorkbenchPanelTabs(tabs, "map", "map")

    expect(result.tabs).toEqual([
      { id: "map", panelId: "plugin:research-map", resourceId: "map", state: { view: "map" } },
    ])
  })

  test("is a no-op when the kept tab is missing", () => {
    const tabs = [
      { id: "a", panelId: "file" },
      { id: "b", panelId: "file" },
    ]
    const result = closeOtherWorkbenchPanelTabs(tabs, "b", "missing")

    expect(result.tabs).toBe(tabs)
    expect(result.active).toBe("b")
  })

  test("bounded closing set removes exactly the snapshot and keeps tabs opened during the window", () => {
    const tabs = [
      { id: "a", panelId: "file" },
      { id: "b", panelId: "file" },
      { id: "late", panelId: "file" },
    ]
    const result = closeOtherWorkbenchPanelTabs(tabs, "late", "b", new Set(["a"]))

    expect(result.tabs.map((tab) => tab.id)).toEqual(["b", "late"])
    expect(result.active).toBe("b")
  })

  test("kept tab removed concurrently leaves the bounded result untouched", () => {
    const result = closeOtherWorkbenchPanelTabs([{ id: "c", panelId: "notes" }], "c", "a", new Set(["a", "b"]))

    expect(result.tabs).toEqual([{ id: "c", panelId: "notes" }])
    expect(result.active).toBe("c")
  })

  test("a bounded close of the last tab empties the surface", () => {
    const result = closeOtherWorkbenchPanelTabs([{ id: "a", panelId: "file" }], "a", "missing", new Set(["a"]))

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

  test("keeps panel content mounted while tab metadata changes", () => {
    const before = { id: "notes:1", panelId: "notes", resourceId: "note_a", source: "/repo" }
    const after = { ...before, resourceId: "notes:list" }

    expect(workbenchPanelMountKey(after)).toBe(workbenchPanelMountKey(before))
    expect(workbenchPanelMountKey({ id: "notes:2", panelId: "notes" })).not.toBe(workbenchPanelMountKey(before))
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

describe("notes workbench tab state", () => {
  test("tracks the opened note and restores the same target after a session round trip", () => {
    let tabs: WorkbenchPanelTab[] = [{ id: "notes:1", panelId: "notes" }]

    tabs = updateWorkbenchPanelTab(tabs, "notes:1", { resourceId: "note_a", source: "/repo" })
    tabs = updateWorkbenchPanelTab(tabs, "notes:1", { resourceId: "note_b", source: "/repo" })

    expect(tabs).toEqual([{ id: "notes:1", panelId: "notes", resourceId: "note_b", source: "/repo" }])
  })

  test("records the list view as an explicit marker instead of a stale note", () => {
    const tabs = [{ id: "notes:1", panelId: "notes", resourceId: "note_a", source: "/repo" }]

    const result = updateWorkbenchPanelTab(tabs, "notes:1", { resourceId: "notes:list" })

    expect(result[0]!.resourceId).toBe("notes:list")
  })

  test("reopening the notes panel without a resource keeps the tracked note", () => {
    const tabs = [{ id: "notes:1", panelId: "notes", resourceId: "note_a", source: "/repo" }]
    const result = openWorkbenchPanelTab({
      panelId: "notes",
      cardinality: "singleton",
      tabs,
      createId: () => "notes:new",
    })

    expect(result.tabs).toBe(tabs)
    expect(result.active).toBe("notes:1")
  })
})

describe("workbench Escape routing", () => {
  test("keeps the workspace open while a nested dialog owns Escape", () => {
    expect(
      resolveWorkbenchEscapeAction({
        key: "Escape",
        opened: true,
        menuOpen: false,
        dialogActive: true,
      }),
    ).toBe("none")
  })

  test("closes any open menu before the workspace and ignores unrelated keys", () => {
    expect(resolveWorkbenchEscapeAction({ key: "Escape", opened: true, menuOpen: true, dialogActive: false })).toBe(
      "close-menu",
    )
    expect(resolveWorkbenchEscapeAction({ key: "Escape", opened: true, menuOpen: false, dialogActive: false })).toBe(
      "close-surface",
    )
    expect(resolveWorkbenchEscapeAction({ key: "Enter", opened: true, menuOpen: false, dialogActive: false })).toBe(
      "none",
    )
  })

  test("lets Escape through to editable targets instead of closing the workspace", () => {
    expect(
      resolveWorkbenchEscapeAction({
        key: "Escape",
        opened: true,
        menuOpen: false,
        dialogActive: false,
        editableFocus: true,
      }),
    ).toBe("none")
    expect(
      resolveWorkbenchEscapeAction({
        key: "Escape",
        opened: true,
        menuOpen: true,
        dialogActive: false,
        editableFocus: true,
      }),
    ).toBe("none")
  })
})

test("escape menu registry arbitrates across mounted surfaces", () => {
  const unregisterIdle = registerWorkbenchEscapeMenu({
    isAnyMenuOpen: () => false,
    closeMenus: () => {},
  })
  const unregisterOpen = registerWorkbenchEscapeMenu({
    isAnyMenuOpen: () => true,
    closeMenus: () => {},
  })
  expect(anyWorkbenchEscapeMenuOpen()).toBe(true)
  unregisterOpen()
  expect(anyWorkbenchEscapeMenuOpen()).toBe(false)
  unregisterIdle()
  expect(anyWorkbenchEscapeMenuOpen()).toBe(false)
})

test("closeAllWorkbenchEscapeMenus closes every registered menu", () => {
  let closedFirst = 0
  let closedSecond = 0
  const unregisterFirst = registerWorkbenchEscapeMenu({
    isAnyMenuOpen: () => true,
    closeMenus: () => {
      closedFirst += 1
    },
  })
  const unregisterSecond = registerWorkbenchEscapeMenu({
    isAnyMenuOpen: () => true,
    closeMenus: () => {
      closedSecond += 1
    },
  })
  closeAllWorkbenchEscapeMenus()
  expect(closedFirst).toBe(1)
  expect(closedSecond).toBe(1)
  unregisterFirst()
  unregisterSecond()
})

describe("isEditableEscapeTarget", () => {
  test("treats form controls as editable", () => {
    const input = document.createElement("input")
    const textarea = document.createElement("textarea")
    const select = document.createElement("select")
    expect(isEditableEscapeTarget(input)).toBe(true)
    expect(isEditableEscapeTarget(textarea)).toBe(true)
    expect(isEditableEscapeTarget(select)).toBe(true)
  })

  test("treats contentEditable regions as editable", () => {
    const editable = document.createElement("div")
    editable.contentEditable = "true"
    expect(isEditableEscapeTarget(editable)).toBe(true)
  })

  test("treats elements inside a protected region as editable", () => {
    const protectedRoot = document.createElement("div")
    protectedRoot.setAttribute("data-prevent-autofocus", "")
    const child = document.createElement("span")
    protectedRoot.appendChild(child)
    expect(isEditableEscapeTarget(child)).toBe(true)
    expect(isEditableEscapeTarget(protectedRoot)).toBe(true)
  })

  test("leaves ordinary targets untouched", () => {
    const button = document.createElement("button")
    expect(isEditableEscapeTarget(button)).toBe(false)
    expect(isEditableEscapeTarget(null)).toBe(false)
    expect(isEditableEscapeTarget(undefined)).toBe(false)
  })
})

describe("workbench panel launchability", () => {
  test("keeps programmatic resource panels out of launchers without affecting existing panels", () => {
    expect(
      isWorkbenchPanelLaunchable({
        id: "attachment",
        label: "Attachment",
        icon: "file",
        pluginId: "builtin",
        surface: "side",
        cardinality: "multi",
        launchable: false,
      }),
    ).toBe(false)
    expect(
      isWorkbenchPanelLaunchable({
        id: "plugin-panel",
        label: "Plugin",
        icon: "file",
        pluginId: "plugin",
        surface: "side",
        cardinality: "multi",
      }),
    ).toBe(true)
  })
})
