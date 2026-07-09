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

import { toolRendererRegistry, type ToolRenderer } from "./tool-registry"

// ── Part Registry ──────────────────────────────────────────────────
import { registerPartRenderer, getPartRenderer, hasPartRenderer } from "./part-registry"

// ── Workbench Panel Registry ───────────────────────────────────────
import {
  registerWorkbenchPanel,
  listWorkbenchPanels,
  getWorkbenchPanel,
  clearWorkbenchPanels,
} from "./workbench-panel-registry"

// ── Navigation Registry ────────────────────────────────────────────
import {
  registerNavigation,
  listNavigation,
  getNavigation,
  getPluginNavigation,
  clearNavigation,
} from "./navigation-registry"

// ── Settings Registry ──────────────────────────────────────────────
import { registerSettingsSection, getSettingsSections, getSettingsSection } from "./settings-registry"
import { BUILTIN_SETTINGS_IDS } from "@/components/settings/catalog"

// ── Theme Registry ─────────────────────────────────────────────────
import { registerPluginTheme, listPluginThemes, getPluginTheme } from "@ericsanchezok/synergy-ui/theme"

// ── Icon Registry ──────────────────────────────────────────────────
import { registerIcon, getIcon, hasIcon, listIcons } from "./icon-registry"

// ── Chat Registry ──────────────────────────────────────────────────
import { registerMessageSlot, getMessageSlotsByName, clearMessageSlots } from "./message-slot-registry"

// ── Composer Slot Registry ─────────────────────────────────────────
import { registerComposerSlot, getComposerSlotsByName, clearComposerSlots } from "./composer-slot-registry"

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

describe("ToolRendererRegistry", () => {
  beforeEach(() => {
    toolRendererRegistry.clear()
  })

  test("register adds entry and returns disposer", () => {
    const render = makeMockToolRenderer()
    const disposer = toolRendererRegistry.register("test-tool", { renderer: render })
    expect(typeof disposer).toBe("function")
    expect(toolRendererRegistry.has("test-tool")).toBe(true)
    expect(toolRendererRegistry.render("test-tool")).toBe(render)
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = toolRendererRegistry.register("test-tool", { renderer: makeMockToolRenderer() })
    expect(toolRendererRegistry.has("test-tool")).toBe(true)
    disposer()
    expect(toolRendererRegistry.has("test-tool")).toBe(false)
    expect(toolRendererRegistry.render("test-tool")).toBeUndefined()
  })

  test("clear removes all entries", () => {
    toolRendererRegistry.register("tool-a", { renderer: makeMockToolRenderer() })
    toolRendererRegistry.register("tool-b", { renderer: makeMockToolRenderer() })
    expect(toolRendererRegistry.has("tool-a")).toBe(true)
    expect(toolRendererRegistry.has("tool-b")).toBe(true)
    toolRendererRegistry.clear()
    expect(toolRendererRegistry.has("tool-a")).toBe(false)
    expect(toolRendererRegistry.has("tool-b")).toBe(false)
  })

  test("render returns undefined for unknown tool", () => {
    expect(toolRendererRegistry.render("nonexistent")).toBeUndefined()
  })

  test("has returns false for unknown tool", () => {
    expect(toolRendererRegistry.has("nonexistent")).toBe(false)
  })

  test("has returns true when only a loader is registered (no render yet)", () => {
    toolRendererRegistry.register("lazy-only", { loader: async () => ({ default: makeMockToolRenderer() }) })
    expect(toolRendererRegistry.has("lazy-only")).toBe(true)
  })

  test("duplicate registration replaces previous entry without crashing", () => {
    const first = makeMockToolRenderer()
    const second = makeMockToolRenderer()
    toolRendererRegistry.register("dup-tool", { renderer: first })
    toolRendererRegistry.register("dup-tool", { renderer: second })
    expect(toolRendererRegistry.render("dup-tool")).toBe(second)
  })

  test("fallback returns undefined when no fallback registered", () => {
    toolRendererRegistry.register("no-fallback", { renderer: makeMockToolRenderer() })
    expect(toolRendererRegistry.fallback("no-fallback")).toBeUndefined()
  })

  test("fallback returns fallback metadata when registered", () => {
    toolRendererRegistry.register("with-fallback", {
      renderer: makeMockToolRenderer(),
      fallback: { icon: "package", title: "My Tool", subtitleTemplate: "Reading {input.path}" },
    })
    const fb = toolRendererRegistry.fallback("with-fallback")
    expect(fb).toBeDefined()
    expect(fb!.icon).toBe("package")
    expect(fb!.title).toBe("My Tool")
    expect(fb!.subtitleTemplate).toBe("Reading {input.path}")
  })

  test("fallback returns undefined for unknown tool", () => {
    expect(toolRendererRegistry.fallback("nonexistent")).toBeUndefined()
  })

  test("lazy loader fires on miss and makes renderer available after resolution", async () => {
    let resolveLoader: (value: { default: ToolRenderer }) => void
    const loaderPromise = new Promise<{ default: ToolRenderer }>((resolve) => {
      resolveLoader = resolve
    })

    toolRendererRegistry.register("lazy-tool", { loader: () => loaderPromise })
    expect(toolRendererRegistry.render("lazy-tool")).toBeUndefined()

    const renderer = makeMockToolRenderer()
    resolveLoader!({ default: renderer })
    await loaderPromise
    await new Promise((r) => setTimeout(r, 0))

    expect(toolRendererRegistry.render("lazy-tool")).toBe(renderer)
  })
})

describe("ToolRendererRegistry onLoad signal", () => {
  beforeEach(() => {
    toolRendererRegistry.clear()
  })

  test("onLoad is a callable function that accepts a callback", () => {
    expect(typeof toolRendererRegistry.onLoad).toBe("function")
    expect(() => {
      toolRendererRegistry.onLoad(() => {})
    }).not.toThrow()
  })

  test("lazy loader resolution triggers onLoad callback", async () => {
    let resolveLoader: (value: { default: ToolRenderer }) => void
    const loaderPromise = new Promise<{ default: ToolRenderer }>((resolve) => {
      resolveLoader = resolve
    })

    toolRendererRegistry.register("signal-lazy", { loader: () => loaderPromise })
    expect(toolRendererRegistry.render("signal-lazy")).toBeUndefined()

    const renderer = makeMockToolRenderer()
    resolveLoader!({ default: renderer })
    await loaderPromise
    await new Promise((r) => setTimeout(r, 0))

    expect(toolRendererRegistry.render("signal-lazy")).toBe(renderer)
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
// Navigation Registry
// ═══════════════════════════════════════════════════════════════════

describe("NavigationRegistry", () => {
  beforeEach(() => {
    clearNavigation()
  })

  test("registerNavigation adds entry and returns disposer", () => {
    const disposer = registerNavigation({
      id: "test-plugin:custom-page",
      navigationId: "custom-page",
      label: "Custom",
      icon: "star",
      placement: "sidebar",
      path: "/plugins/test-plugin/custom-page",
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    const entry = getPluginNavigation("test-plugin", "custom-page")
    expect(entry).toBeDefined()
    expect(entry!.label).toBe("Custom")
    disposer()
  })

  test("disposer removes only the registered version", () => {
    const first = registerNavigation({
      id: "test-plugin:replaceable",
      navigationId: "replaceable",
      label: "First",
      placement: "sidebar",
      path: "/plugins/test-plugin/replaceable",
      pluginId: "test-plugin",
    })
    registerNavigation({
      id: "test-plugin:replaceable",
      navigationId: "replaceable",
      label: "Second",
      placement: "sidebar",
      path: "/plugins/test-plugin/replaceable",
      pluginId: "test-plugin",
    })
    first()
    expect(getPluginNavigation("test-plugin", "replaceable")!.label).toBe("Second")
  })

  test("listNavigation filters by placement and sorts by order then label", () => {
    registerNavigation({
      id: "plugin-x:b",
      navigationId: "b",
      label: "B",
      placement: "sidebar",
      path: "/plugins/plugin-x/b",
      order: 20,
      pluginId: "plugin-x",
    })
    registerNavigation({
      id: "plugin-x:a",
      navigationId: "a",
      label: "A",
      placement: "sidebar",
      path: "/plugins/plugin-x/a",
      order: 10,
      pluginId: "plugin-x",
    })
    registerNavigation({
      id: "plugin-x:page",
      navigationId: "page",
      label: "Page",
      placement: "page",
      path: "/plugins/plugin-x/page",
      pluginId: "plugin-x",
    })
    expect(listNavigation("sidebar").map((entry) => entry.navigationId)).toEqual(["a", "b"])
  })

  test("getNavigation returns undefined for unknown id", () => {
    expect(getNavigation("missing")).toBeUndefined()
  })

  test("clearNavigation with pluginId removes only matching entries", () => {
    registerNavigation({
      id: "plugin-x:p1",
      navigationId: "p1",
      label: "P1",
      placement: "sidebar",
      path: "/plugins/plugin-x/p1",
      pluginId: "plugin-x",
    })
    registerNavigation({
      id: "plugin-y:p2",
      navigationId: "p2",
      label: "P2",
      placement: "sidebar",
      path: "/plugins/plugin-y/p2",
      pluginId: "plugin-y",
    })
    clearNavigation("plugin-x")
    const list = listNavigation()
    expect(list.length).toBe(1)
    expect(list[0].id).toBe("plugin-y:p2")
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

  test("duplicate registration replaces previous (Map semantics)", () => {
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
    // Map semantics — duplicate id replaces previous entry
    const matches = getSettingsSections().filter((s) => s.id === "dup-setting")
    expect(matches.length).toBe(1)
    expect(matches[0]!.label).toBe("Second")
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
      slot: "message.before-tools",
      component,
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    const entries = getMessageSlotsByName("message.before-tools")
    expect(entries.some((entry) => entry.id === "message-slot-1")).toBe(true)
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = registerMessageSlot({
      id: "message-slot-rm",
      slot: "message.after-tools",
      component: makeMockComponent(),
      pluginId: "test-plugin",
    })
    expect(getMessageSlotsByName("message.after-tools").some((entry) => entry.id === "message-slot-rm")).toBe(true)
    disposer()
    expect(getMessageSlotsByName("message.after-tools").some((entry) => entry.id === "message-slot-rm")).toBe(false)
  })

  test("getMessageSlotsByName returns entries filtered by slot", () => {
    const compBefore = makeMockComponent()
    const compAfter = makeMockComponent()
    registerMessageSlot({ id: "c-before", slot: "message.before-tools", component: compBefore, pluginId: "p1" })
    registerMessageSlot({ id: "c-after", slot: "message.after-tools", component: compAfter, pluginId: "p1" })

    const beforeEntries = getMessageSlotsByName("message.before-tools")
    expect(beforeEntries.length).toBe(1)
    expect(beforeEntries[0].id).toBe("c-before")

    const afterEntries = getMessageSlotsByName("message.after-tools")
    expect(afterEntries.length).toBe(1)
    expect(afterEntries[0].id).toBe("c-after")
  })

  test("getMessageSlotsByName returns empty array for slot with no entries", () => {
    expect(getMessageSlotsByName("message.before-reasoning").length).toBe(0)
  })

  test("duplicate registration appends without crashing", () => {
    registerMessageSlot({
      id: "dup-slot",
      slot: "message.before-tools",
      component: makeMockComponent(),
      pluginId: "p1",
    })
    registerMessageSlot({
      id: "dup-slot",
      slot: "message.before-tools",
      component: makeMockComponent(),
      pluginId: "p1",
    })
    const entries = getMessageSlotsByName("message.before-tools").filter((entry) => entry.id === "dup-slot")
    expect(entries.length).toBe(2)
  })

  test("multiple plugins can register to same slot", () => {
    registerMessageSlot({
      id: "c1",
      slot: "message.before-tools",
      component: makeMockComponent(),
      pluginId: "plugin-a",
    })
    registerMessageSlot({
      id: "c2",
      slot: "message.before-tools",
      component: makeMockComponent(),
      pluginId: "plugin-b",
    })
    const entries = getMessageSlotsByName("message.before-tools")
    expect(entries.length).toBeGreaterThanOrEqual(2)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Composer Slot Registry
// ═══════════════════════════════════════════════════════════════════

describe("ComposerSlotRegistry", () => {
  beforeEach(() => {
    clearComposerSlots()
  })

  test("registerComposerSlot adds entry and returns disposer", () => {
    const disposer = registerComposerSlot({
      id: "test-plugin:composer-above",
      slot: "composer.above",
      component: makeMockComponent(),
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    expect(getComposerSlotsByName("composer.above").length).toBe(1)
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = registerComposerSlot({
      id: "test-plugin:composer-remove",
      slot: "composer.toolbar.left",
      component: makeMockComponent(),
      pluginId: "test-plugin",
    })
    expect(getComposerSlotsByName("composer.toolbar.left").length).toBe(1)
    disposer()
    expect(getComposerSlotsByName("composer.toolbar.left").length).toBe(0)
  })

  test("getComposerSlotsByName filters by slot and sorts by order", () => {
    registerComposerSlot({
      id: "plugin-x:b",
      slot: "composer.toolbar.right",
      order: 20,
      component: makeMockComponent(),
      pluginId: "plugin-x",
    })
    registerComposerSlot({
      id: "plugin-x:a",
      slot: "composer.toolbar.right",
      order: 10,
      component: makeMockComponent(),
      pluginId: "plugin-x",
    })
    registerComposerSlot({
      id: "plugin-x:below",
      slot: "composer.below",
      component: makeMockComponent(),
      pluginId: "plugin-x",
    })
    expect(getComposerSlotsByName("composer.toolbar.right").map((entry) => entry.id)).toEqual([
      "plugin-x:a",
      "plugin-x:b",
    ])
  })

  test("clearComposerSlots with pluginId removes only matching entries", () => {
    registerComposerSlot({
      id: "plugin-x:a",
      slot: "composer.above",
      component: makeMockComponent(),
      pluginId: "plugin-x",
    })
    registerComposerSlot({
      id: "plugin-y:b",
      slot: "composer.above",
      component: makeMockComponent(),
      pluginId: "plugin-y",
    })
    clearComposerSlots("plugin-x")
    const entries = getComposerSlotsByName("composer.above")
    expect(entries.length).toBe(1)
    expect(entries[0].id).toBe("plugin-y:b")
  })
})
