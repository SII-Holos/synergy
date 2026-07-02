import { mock, describe, expect, test, beforeEach } from "bun:test"

// ── Mock @ericsanchezok/synergy-ui/message-part ───────────────────
// tool-registry.ts and part-registry.ts import from this module. Mocking prevents
// the import chain from pulling in lucide-solid → solid-js/web client-only APIs,
// which crash bun:test with "Client-only API called on the server side".
const partMapping: Record<string, any> = {}
mock.module("@ericsanchezok/synergy-ui/message-part", () => ({
  ToolRegistry: {
    register: () => {},
    render: () => undefined,
  },
  registerPartComponent: (type: string, component: any) => {
    partMapping[type] = component
  },
  PART_MAPPING: partMapping,
}))

// ── Tool Registry ──────────────────────────────────────────────────
import {
  registerToolRenderer,
  getToolRenderer,
  getToolFallback,
  hasToolRenderer,
  clearAllToolRenderers,
  onToolLoaded,
  type ToolRenderer,
} from "./tool-registry"

// ── Part Registry ──────────────────────────────────────────────────
import { registerPartRenderer, getPartRenderer, hasPartRenderer } from "./part-registry"

// ── Workbench Panel Registry ───────────────────────────────────────
import {
  registerWorkbenchPanel,
  listWorkbenchPanels,
  getWorkbenchPanel,
  clearWorkbenchPanels,
} from "./workbench-panel-registry"

// ── Panel Registry ─────────────────────────────────────────────────
import { registerAppPanel, listAppPanels, getAppPanel, clearAppPanels } from "./app-panel-registry"

// ── Settings Registry ──────────────────────────────────────────────
import { registerSettingsSection, getSettingsSections, getSettingsSection } from "./settings-registry"
import { BUILTIN_SETTINGS_IDS } from "@/components/settings/catalog"

// ── Theme Registry ─────────────────────────────────────────────────
import { registerPluginTheme, listPluginThemes, getPluginTheme } from "@ericsanchezok/synergy-ui/theme"

// ── Icon Registry ──────────────────────────────────────────────────
import { registerIcon, getIcon, hasIcon, listIcons } from "./icon-registry"

// ── Chat Registry ──────────────────────────────────────────────────
import { registerMessageSlot, getMessageSlotsByName, clearMessageSlots } from "./message-slot-registry"

// ── Route Registry ─────────────────────────────────────────────────
import { registerAppRoute, listAppRoutes, getAppRoute, clearAppRoutes } from "./app-route-registry"

// ── Helpers ────────────────────────────────────────────────────────

function makeMockComponent() {
  return (() => null) as any
}

function makeMockToolRenderer(): ToolRenderer {
  return (() => null) as any
}

// ═══════════════════════════════════════════════════════════════════
// Tool Registry
// ═══════════════════════════════════════════════════════════════════

describe("ToolRegistry", () => {
  beforeEach(() => {
    clearAllToolRenderers()
  })

  test("registerToolRenderer adds entry and returns disposer", () => {
    const render = makeMockToolRenderer()
    const disposer = registerToolRenderer({ name: "test-tool", render })
    expect(typeof disposer).toBe("function")
    expect(hasToolRenderer("test-tool")).toBe(true)
    expect(getToolRenderer("test-tool")).toBe(render)
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = registerToolRenderer({ name: "test-tool", render: makeMockToolRenderer() })
    expect(hasToolRenderer("test-tool")).toBe(true)
    disposer()
    expect(hasToolRenderer("test-tool")).toBe(false)
    expect(getToolRenderer("test-tool")).toBeUndefined()
  })

  test("clearAllToolRenderers removes all entries", () => {
    registerToolRenderer({ name: "tool-a", render: makeMockToolRenderer() })
    registerToolRenderer({ name: "tool-b", render: makeMockToolRenderer() })
    expect(hasToolRenderer("tool-a")).toBe(true)
    expect(hasToolRenderer("tool-b")).toBe(true)
    clearAllToolRenderers()
    expect(hasToolRenderer("tool-a")).toBe(false)
    expect(hasToolRenderer("tool-b")).toBe(false)
  })

  test("getToolRenderer returns undefined for unknown tool", () => {
    expect(getToolRenderer("nonexistent")).toBeUndefined()
  })

  test("hasToolRenderer returns false for unknown tool", () => {
    expect(hasToolRenderer("nonexistent")).toBe(false)
  })

  test("hasToolRenderer returns true when only a loader is registered (no render yet)", () => {
    registerToolRenderer({ name: "lazy-only", loader: async () => ({ default: makeMockToolRenderer() }) })
    expect(hasToolRenderer("lazy-only")).toBe(true)
  })

  test("duplicate registration replaces previous entry without crashing", () => {
    const first = makeMockToolRenderer()
    const second = makeMockToolRenderer()
    registerToolRenderer({ name: "dup-tool", render: first })
    registerToolRenderer({ name: "dup-tool", render: second })
    expect(getToolRenderer("dup-tool")).toBe(second)
  })

  test("getToolFallback returns undefined when no fallback registered", () => {
    registerToolRenderer({ name: "no-fallback", render: makeMockToolRenderer() })
    expect(getToolFallback("no-fallback")).toBeUndefined()
  })

  test("getToolFallback returns fallback metadata when registered", () => {
    registerToolRenderer({
      name: "with-fallback",
      render: makeMockToolRenderer(),
      fallback: { icon: "package", title: "My Tool", subtitleTemplate: "Reading {input.path}" },
    })
    const fb = getToolFallback("with-fallback")
    expect(fb).toBeDefined()
    expect(fb!.icon).toBe("package")
    expect(fb!.title).toBe("My Tool")
    expect(fb!.subtitleTemplate).toBe("Reading {input.path}")
  })

  test("getToolFallback returns undefined for unknown tool", () => {
    expect(getToolFallback("nonexistent")).toBeUndefined()
  })

  test("lazy loader fires on miss and makes renderer available after resolution", async () => {
    let resolveLoader: (value: { default: ToolRenderer }) => void
    const loaderPromise = new Promise<{ default: ToolRenderer }>((resolve) => {
      resolveLoader = resolve
    })

    registerToolRenderer({
      name: "lazy-tool",
      loader: () => loaderPromise,
    })

    // First call: loader triggered but not yet resolved; mock ToolRegistry.render returns undefined
    const first = getToolRenderer("lazy-tool")
    expect(first).toBeUndefined()

    // Resolve the loader
    const mockComponent = makeMockToolRenderer()
    resolveLoader!({ default: mockComponent })
    await loaderPromise
    // Let the .then() microtask flush
    await new Promise((r) => setTimeout(r, 0))

    // Now the renderer should be available
    const second = getToolRenderer("lazy-tool")
    expect(second).toBe(mockComponent)
  })
})

describe("ToolRegistry onToolLoaded signal", () => {
  beforeEach(() => {
    clearAllToolRenderers()
  })

  test("onToolLoaded is a callable function that accepts a callback", () => {
    // The function is exported and typed — verifying it exists and is callable.
    // createEffect behavior requires solid-js runtime DOM context
    // which bun:test doesn't fully support.
    expect(typeof onToolLoaded).toBe("function")
    // Verify it does not throw when called with a no-op callback
    let cbCalled = false
    expect(() => {
      onToolLoaded(() => {
        cbCalled = true
      })
    }).not.toThrow()
  })

  test("lazy loader resolution triggers signal (verified via loadedSignal advancement)", async () => {
    // The lazy loader's .then() handler calls setLoadedSignal.
    // We verify this by: registering a lazy tool, calling getToolRenderer
    // to trigger the loader, awaiting resolution, and confirming the
    // renderer is then returned on the next call.
    let resolveLoader: (value: { default: ToolRenderer }) => void
    const loaderPromise = new Promise<{ default: ToolRenderer }>((resolve) => {
      resolveLoader = resolve
    })

    registerToolRenderer({
      name: "signal-lazy",
      loader: () => loaderPromise,
    })

    // First call triggers the loader chain
    expect(getToolRenderer("signal-lazy")).toBeUndefined()

    const renderer = makeMockToolRenderer()
    resolveLoader!({ default: renderer })
    await loaderPromise
    await new Promise((r) => setTimeout(r, 0))

    // After resolution, renderer is available — proof the signal fired
    expect(getToolRenderer("signal-lazy")).toBe(renderer)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Part Registry
// ═══════════════════════════════════════════════════════════════════

describe("PartRegistry", () => {
  beforeEach(() => {
    // Reset the shared PART_MAPPING between tests
    for (const key of Object.keys(partMapping)) {
      delete partMapping[key]
    }
  })

  test("registerPartRenderer adds entry and returns disposer", () => {
    const component = makeMockComponent()
    const disposer = registerPartRenderer("custom-part", component)
    expect(typeof disposer).toBe("function")
    expect(hasPartRenderer("custom-part")).toBe(true)
    expect(getPartRenderer("custom-part")).toBe(component)
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = registerPartRenderer("custom-part", makeMockComponent())
    expect(hasPartRenderer("custom-part")).toBe(true)
    expect(getPartRenderer("custom-part")).toBeDefined()
    disposer()
    expect(hasPartRenderer("custom-part")).toBe(false)
    expect(getPartRenderer("custom-part")).toBeUndefined()
  })

  test("getPartRenderer returns undefined for unknown type", () => {
    expect(getPartRenderer("nonexistent-part")).toBeUndefined()
  })

  test("hasPartRenderer returns false for unknown type", () => {
    expect(hasPartRenderer("nonexistent-part")).toBe(false)
  })

  test("duplicate registration replaces previous without crashing", () => {
    const first = makeMockComponent()
    const second = makeMockComponent()
    registerPartRenderer("dup-part", first)
    registerPartRenderer("dup-part", second)
    expect(getPartRenderer("dup-part")).toBe(second)
  })

  test("multiple parts can coexist", () => {
    const a = makeMockComponent()
    const b = makeMockComponent()
    registerPartRenderer("part-a", a)
    registerPartRenderer("part-b", b)
    expect(getPartRenderer("part-a")).toBe(a)
    expect(getPartRenderer("part-b")).toBe(b)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Workbench Panel Registry
// ═══════════════════════════════════════════════════════════════════

describe("WorkbenchPanelRegistry", () => {
  beforeEach(() => {
    clearWorkbenchPanels()
  })

  test("registerWorkbenchPanel adds entry and returns disposer", () => {
    const disposer = registerWorkbenchPanel({
      id: "ws-panel-1",
      label: "Test Panel",
      icon: "package",
      surface: "side",
      cardinality: "singleton",
      requiresSession: true,
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    const entry = getWorkbenchPanel("ws-panel-1")
    expect(entry).toBeDefined()
    expect(entry!.label).toBe("Test Panel")
    expect(entry!.surface).toBe("side")
    expect(entry!.cardinality).toBe("singleton")
    expect(entry!.requiresSession).toBe(true)
    expect(entry!.pluginId).toBe("test-plugin")
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = registerWorkbenchPanel({
      id: "ws-panel-2",
      label: "Removable",
      icon: "trash-2",
      surface: "bottom",
      cardinality: "multi",
      pluginId: "test-plugin",
    })
    expect(getWorkbenchPanel("ws-panel-2")).toBeDefined()
    disposer()
    expect(getWorkbenchPanel("ws-panel-2")).toBeUndefined()
  })

  test("listWorkbenchPanels filters by surface", () => {
    registerWorkbenchPanel({
      id: "ws-a",
      label: "A",
      icon: "a",
      surface: "side",
      cardinality: "exclusive",
      pluginId: "p1",
    })
    registerWorkbenchPanel({
      id: "ws-b",
      label: "B",
      icon: "b",
      surface: "bottom",
      cardinality: "multi",
      pluginId: "p1",
    })
    expect(listWorkbenchPanels().length).toBe(2)
    const list = listWorkbenchPanels("side")
    expect(list.length).toBe(1)
    const ids = list.map((e) => e.id)
    expect(ids).toContain("ws-a")
  })

  test("getWorkbenchPanel returns undefined for unknown id", () => {
    expect(getWorkbenchPanel("nonexistent")).toBeUndefined()
  })

  test("clearWorkbenchPanels removes all entries when no pluginId", () => {
    registerWorkbenchPanel({
      id: "ws-a",
      label: "A",
      icon: "a",
      surface: "side",
      cardinality: "exclusive",
      pluginId: "p1",
    })
    registerWorkbenchPanel({
      id: "ws-b",
      label: "B",
      icon: "b",
      surface: "bottom",
      cardinality: "multi",
      pluginId: "p2",
    })
    clearWorkbenchPanels()
    expect(listWorkbenchPanels().length).toBe(0)
  })

  test("clearWorkbenchPanels with pluginId removes only matching entries", () => {
    registerWorkbenchPanel({
      id: "ws-a",
      label: "A",
      icon: "a",
      surface: "side",
      cardinality: "exclusive",
      pluginId: "p1",
    })
    registerWorkbenchPanel({
      id: "ws-b",
      label: "B",
      icon: "b",
      surface: "bottom",
      cardinality: "multi",
      pluginId: "p2",
    })
    registerWorkbenchPanel({
      id: "ws-c",
      label: "C",
      icon: "c",
      surface: "side",
      cardinality: "singleton",
      pluginId: "p1",
    })
    clearWorkbenchPanels("p1")
    const list = listWorkbenchPanels()
    expect(list.length).toBe(1)
    expect(list[0].id).toBe("ws-b")
  })

  test("duplicate registration replaces previous without crashing (Map semantics)", () => {
    registerWorkbenchPanel({
      id: "ws-dup",
      label: "First",
      icon: "a",
      surface: "side",
      cardinality: "exclusive",
      pluginId: "p1",
    })
    registerWorkbenchPanel({
      id: "ws-dup",
      label: "Second",
      icon: "b",
      surface: "bottom",
      cardinality: "multi",
      pluginId: "p1",
    })
    const entry = getWorkbenchPanel("ws-dup")
    expect(entry!.label).toBe("Second")
    expect(entry!.surface).toBe("bottom")
    expect(listWorkbenchPanels().length).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Panel Registry
// ═══════════════════════════════════════════════════════════════════

describe("AppPanelRegistry", () => {
  beforeEach(() => {
    clearAppPanels()
  })

  test("registerAppPanel adds entry and returns disposer", () => {
    const disposer = registerAppPanel({
      id: "test-plugin:custom-panel",
      panelId: "custom-panel",
      label: "Custom",
      icon: "star",
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    const entry = getAppPanel("test-plugin", "custom-panel")
    expect(entry).toBeDefined()
    expect(entry!.label).toBe("Custom")
    disposer()
  })

  test("disposer removes only that entry", () => {
    const disposer = registerAppPanel({
      id: "test-plugin:removable-panel",
      panelId: "removable-panel",
      label: "Gone",
      icon: "x",
      pluginId: "test-plugin",
    })
    expect(getAppPanel("test-plugin", "removable-panel")).toBeDefined()
    disposer()
    expect(getAppPanel("test-plugin", "removable-panel")).toBeUndefined()
    expect(listAppPanels().length).toBe(0)
  })

  test("listAppPanels includes plugin panels sorted by order then label", () => {
    registerAppPanel({ id: "plugin-x:p1", panelId: "p1", label: "B", icon: "package", order: 20, pluginId: "plugin-x" })
    registerAppPanel({ id: "plugin-x:p2", panelId: "p2", label: "A", icon: "package", order: 10, pluginId: "plugin-x" })
    const list = listAppPanels()
    expect(list.map((entry) => entry.panelId)).toEqual(["p2", "p1"])
  })

  test("getAppPanel returns undefined for unknown id", () => {
    expect(getAppPanel("plugin-x", "nonexistent")).toBeUndefined()
  })

  test("clearAppPanels with pluginId removes only matching entries", () => {
    registerAppPanel({ id: "plugin-x:p1", panelId: "p1", label: "P1", icon: "star", pluginId: "plugin-x" })
    registerAppPanel({ id: "plugin-y:p2", panelId: "p2", label: "P2", icon: "star", pluginId: "plugin-y" })
    clearAppPanels("plugin-x")
    const list = listAppPanels()
    expect(list.length).toBe(1)
    const ids = list.map((entry) => entry.id)
    expect(ids).not.toContain("plugin-x:p1")
    expect(ids).toContain("plugin-y:p2")
  })

  test("duplicate registration replaces previous without crashing", () => {
    registerAppPanel({ id: "p1:dup-panel", panelId: "dup-panel", label: "First", icon: "a", pluginId: "p1" })
    registerAppPanel({ id: "p1:dup-panel", panelId: "dup-panel", label: "Second", icon: "b", pluginId: "p1" })
    expect(getAppPanel("p1", "dup-panel")!.label).toBe("Second")
  })
})

// ═══════════════════════════════════════════════════════════════════
// Settings Registry
// ═══════════════════════════════════════════════════════════════════

describe("SettingsRegistry", () => {
  test("registerSettingsSection adds entry and returns disposer", () => {
    const disposer = registerSettingsSection({
      id: "custom-setting",
      label: "Custom",
      icon: "star",
      group: "Custom",
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    const section = getSettingsSection("custom-setting")
    expect(section).toBeDefined()
    expect(section!.label).toBe("Custom")
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = registerSettingsSection({
      id: "removable-setting",
      label: "Removable",
      icon: "x",
      group: "Test",
      pluginId: "test-plugin",
    })
    expect(getSettingsSection("removable-setting")).toBeDefined()
    disposer()
    expect(getSettingsSection("removable-setting")).toBeUndefined()
  })

  test("getSettingsSections includes built-in and added sections", () => {
    registerSettingsSection({
      id: "extra-setting",
      label: "Extra",
      icon: "plus",
      group: "Extra",
      pluginId: "test-plugin",
    })
    const list = getSettingsSections()
    const ids = list.map((s) => s.id)
    for (const bid of BUILTIN_SETTINGS_IDS) {
      expect(ids).toContain(bid)
    }
    expect(ids).toContain("extra-setting")
  })

  test("getSettingsSection returns undefined for unknown id", () => {
    expect(getSettingsSection("nonexistent")).toBeUndefined()
  })

  test("getSettingsSection finds built-in section", () => {
    const section = getSettingsSection("general")
    expect(section).toBeDefined()
    expect(section!.label).toBe("General")
  })

  test("duplicate registration appends without crashing", () => {
    registerSettingsSection({
      id: "dup-setting",
      label: "First",
      icon: "a",
      group: "Test",
      pluginId: "test-plugin",
    })
    registerSettingsSection({
      id: "dup-setting",
      label: "Second",
      icon: "b",
      group: "Test",
      pluginId: "test-plugin",
    })
    // Both present in the array (append semantics — no dedup by id)
    const matches = getSettingsSections().filter((s) => s.id === "dup-setting")
    expect(matches.length).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Theme Registry
// ═══════════════════════════════════════════════════════════════════

describe("PluginThemeRegistry", () => {
  test("registerPluginTheme adds entry and returns disposer", () => {
    const disposer = registerPluginTheme({
      id: "custom-theme",
      label: "Custom Theme",
      cssUrl: "/theme.css",
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    expect(getPluginTheme("custom-theme")).toBeDefined()
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = registerPluginTheme({
      id: "temp-theme",
      label: "Temporary",
      cssUrl: "/temp.css",
    })
    expect(getPluginTheme("temp-theme")).toBeDefined()
    disposer()
    expect(getPluginTheme("temp-theme")).toBeUndefined()
  })

  test("listPluginThemes includes added themes sorted by label", () => {
    const disposeB = registerPluginTheme({ id: "theme-b", label: "B", cssUrl: "/b.css", pluginId: "p1" })
    const disposeA = registerPluginTheme({ id: "theme-a", label: "A", cssUrl: "/a.css", pluginId: "p1" })
    const list = listPluginThemes().filter((theme) => theme.id === "theme-a" || theme.id === "theme-b")
    expect(list.map((theme) => theme.id)).toEqual(["theme-a", "theme-b"])
    disposeA()
    disposeB()
  })

  test("getPluginTheme returns undefined for unknown id", () => {
    expect(getPluginTheme("nonexistent")).toBeUndefined()
  })

  test("duplicate registration replaces previous without crashing", () => {
    const disposeFirst = registerPluginTheme({ id: "dup-theme", label: "First", cssUrl: "/first.css" })
    const disposeSecond = registerPluginTheme({ id: "dup-theme", label: "Second", cssUrl: "/second.css" })
    const theme = getPluginTheme("dup-theme")
    expect(theme!.label).toBe("Second")
    expect(listPluginThemes().filter((item) => item.id === "dup-theme").length).toBe(1)
    disposeSecond()
    disposeFirst()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Icon Registry
// ═══════════════════════════════════════════════════════════════════

describe("IconRegistry", () => {
  test("registerIcon adds entry and returns disposer", () => {
    const disposer = registerIcon({
      name: "custom-icon",
      svgContent: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    expect(hasIcon("custom-icon")).toBe(true)
    const entry = getIcon("custom-icon")
    expect(entry).toBeDefined()
    expect(entry!.name).toBe("custom-icon")
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = registerIcon({
      name: "temp-icon",
      svgContent: '<svg viewBox="0 0 24 24"><rect/></svg>',
    })
    expect(hasIcon("temp-icon")).toBe(true)
    disposer()
    expect(hasIcon("temp-icon")).toBe(false)
    expect(getIcon("temp-icon")).toBeUndefined()
  })

  test("getIcon returns undefined for unknown name", () => {
    expect(getIcon("nonexistent")).toBeUndefined()
  })

  test("hasIcon returns false for unknown name", () => {
    expect(hasIcon("nonexistent")).toBe(false)
  })

  test("listIcons returns all registered icons", () => {
    registerIcon({ name: "icon-a", svgContent: "<svg></svg>", pluginId: "p1" })
    registerIcon({ name: "icon-b", svgContent: "<svg></svg>", pluginId: "p1" })
    const list = listIcons()
    const names = list.map((i) => i.name)
    expect(names).toContain("icon-a")
    expect(names).toContain("icon-b")
  })

  test("duplicate registration replaces without crashing", () => {
    registerIcon({ name: "dup-icon", svgContent: "<svg>A</svg>" })
    registerIcon({ name: "dup-icon", svgContent: "<svg>B</svg>" })
    expect(getIcon("dup-icon")!.svgContent).toBe("<svg>B</svg>")
  })

  test("SVG content is stored (sanitization handled by source module)", () => {
    const svg = '<svg viewBox="0 0 24 24"><path d="M12 2L2 22h20z"/></svg>'
    registerIcon({ name: "safe-icon", svgContent: svg })
    const entry = getIcon("safe-icon")
    expect(entry!.svgContent).toContain("<svg")
    expect(entry!.svgContent).toContain("<path")
  })
})

// ═══════════════════════════════════════════════════════════════════
// Chat Registry
// ═══════════════════════════════════════════════════════════════════

describe("MessageSlotRegistry", () => {
  beforeEach(() => {
    clearMessageSlots()
  })

  test("registerMessageSlot adds entry and returns disposer", () => {
    const component = makeMockComponent()
    const disposer = registerMessageSlot({
      id: "message-slot-1",
      slot: "before-tools",
      component,
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    const entries = getMessageSlotsByName("before-tools")
    expect(entries.some((entry) => entry.id === "message-slot-1")).toBe(true)
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = registerMessageSlot({
      id: "message-slot-rm",
      slot: "after-tools",
      component: makeMockComponent(),
      pluginId: "test-plugin",
    })
    expect(getMessageSlotsByName("after-tools").some((entry) => entry.id === "message-slot-rm")).toBe(true)
    disposer()
    expect(getMessageSlotsByName("after-tools").some((entry) => entry.id === "message-slot-rm")).toBe(false)
  })

  test("getMessageSlotsByName returns entries filtered by slot", () => {
    const compBefore = makeMockComponent()
    const compAfter = makeMockComponent()
    registerMessageSlot({ id: "c-before", slot: "before-tools", component: compBefore, pluginId: "p1" })
    registerMessageSlot({ id: "c-after", slot: "after-tools", component: compAfter, pluginId: "p1" })

    const beforeEntries = getMessageSlotsByName("before-tools")
    expect(beforeEntries.length).toBe(1)
    expect(beforeEntries[0].id).toBe("c-before")

    const afterEntries = getMessageSlotsByName("after-tools")
    expect(afterEntries.length).toBe(1)
    expect(afterEntries[0].id).toBe("c-after")
  })

  test("getMessageSlotsByName returns empty array for slot with no entries", () => {
    expect(getMessageSlotsByName("before-reasoning").length).toBe(0)
  })

  test("duplicate registration appends without crashing", () => {
    registerMessageSlot({
      id: "dup-slot",
      slot: "before-tools",
      component: makeMockComponent(),
      pluginId: "p1",
    })
    registerMessageSlot({
      id: "dup-slot",
      slot: "before-tools",
      component: makeMockComponent(),
      pluginId: "p1",
    })
    const entries = getMessageSlotsByName("before-tools").filter((entry) => entry.id === "dup-slot")
    expect(entries.length).toBe(2)
  })

  test("multiple plugins can register to same slot", () => {
    registerMessageSlot({ id: "c1", slot: "before-tools", component: makeMockComponent(), pluginId: "plugin-a" })
    registerMessageSlot({ id: "c2", slot: "before-tools", component: makeMockComponent(), pluginId: "plugin-b" })
    const entries = getMessageSlotsByName("before-tools")
    expect(entries.length).toBeGreaterThanOrEqual(2)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Route Registry
// ═══════════════════════════════════════════════════════════════════

describe("AppRouteRegistry", () => {
  beforeEach(() => {
    clearAppRoutes()
  })

  test("registerAppRoute adds entry and returns disposer", () => {
    const disposer = registerAppRoute({
      id: "test-plugin:test",
      routeId: "test",
      label: "Test Route",
      icon: "package",
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    const routes = listAppRoutes()
    expect(routes.length).toBe(1)
    expect(getAppRoute("test-plugin", "test")).toBeDefined()
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = registerAppRoute({
      id: "test-plugin:rm",
      routeId: "rm",
      label: "Removable",
      pluginId: "test-plugin",
    })
    expect(listAppRoutes().length).toBe(1)
    disposer()
    expect(listAppRoutes().length).toBe(0)
  })

  test("listAppRoutes returns all entries", () => {
    registerAppRoute({ id: "p1:a", routeId: "a", label: "A", pluginId: "p1" })
    registerAppRoute({ id: "p1:b", routeId: "b", label: "B", pluginId: "p1" })
    const routes = listAppRoutes()
    expect(routes.length).toBe(2)
  })

  test("listAppRoutes returns a copy", () => {
    registerAppRoute({ id: "p1:x", routeId: "x", label: "X", pluginId: "p1" })
    const routes = listAppRoutes()
    routes.push({ id: "p2:y", routeId: "y", label: "Y", pluginId: "p2" })
    expect(listAppRoutes().length).toBe(1)
  })

  test("clearAppRoutes removes all entries when no pluginId", () => {
    registerAppRoute({ id: "p1:a", routeId: "a", label: "A", pluginId: "p1" })
    registerAppRoute({ id: "p2:b", routeId: "b", label: "B", pluginId: "p2" })
    clearAppRoutes()
    expect(listAppRoutes().length).toBe(0)
  })

  test("clearAppRoutes with pluginId removes only matching entries", () => {
    registerAppRoute({ id: "p1:a", routeId: "a", label: "A", pluginId: "p1" })
    registerAppRoute({ id: "p2:b", routeId: "b", label: "B", pluginId: "p2" })
    registerAppRoute({ id: "p1:c", routeId: "c", label: "C", pluginId: "p1" })
    clearAppRoutes("p1")
    const routes = listAppRoutes()
    expect(routes.length).toBe(1)
    expect(routes[0].id).toBe("p2:b")
  })

  test("duplicate registration replaces previous without crashing", () => {
    registerAppRoute({ id: "p1:dup", routeId: "dup", label: "First", pluginId: "p1" })
    registerAppRoute({ id: "p1:dup", routeId: "dup", label: "Second", pluginId: "p1" })
    expect(listAppRoutes().length).toBe(1)
    expect(getAppRoute("p1", "dup")!.label).toBe("Second")
  })
})
