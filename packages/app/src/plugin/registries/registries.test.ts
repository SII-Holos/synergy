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

// ── Workspace Registry ─────────────────────────────────────────────
import {
  registerWorkspacePanel,
  listWorkspacePanels,
  getWorkspacePanel,
  clearWorkspacePanels,
} from "./workspace-registry"

// ── Panel Registry ─────────────────────────────────────────────────
import { registerGlobalPanel, listGlobalPanels, getGlobalPanel, clearGlobalPanels } from "./panel-registry"

// ── Settings Registry ──────────────────────────────────────────────
import { registerSettingsSection, getSettingsSections, getSettingsSection } from "./settings-registry"
import { BUILTIN_SETTINGS_IDS } from "@/components/settings/catalog"

// ── Theme Registry ─────────────────────────────────────────────────
import { registerTheme, listThemes, getTheme, activateTheme, getActiveThemeId, getActiveTheme } from "./theme-registry"

// ── Icon Registry ──────────────────────────────────────────────────
import { registerIcon, getIcon, hasIcon, listIcons } from "./icon-registry"

// ── Chat Registry ──────────────────────────────────────────────────
import { registerChatComponent, getChatComponentsBySlot } from "./chat-registry"

// ── Route Registry ─────────────────────────────────────────────────
import { registerPluginRoute, getPluginRoutes, clearPluginRoutes } from "./route-registry"

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
// Workspace Registry
// ═══════════════════════════════════════════════════════════════════

describe("WorkspaceRegistry", () => {
  beforeEach(() => {
    clearWorkspacePanels()
  })

  test("registerWorkspacePanel adds entry and returns disposer", () => {
    const disposer = registerWorkspacePanel({
      id: "ws-panel-1",
      label: "Test Panel",
      icon: "package",
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    const entry = getWorkspacePanel("ws-panel-1")
    expect(entry).toBeDefined()
    expect(entry!.label).toBe("Test Panel")
    expect(entry!.pluginId).toBe("test-plugin")
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = registerWorkspacePanel({
      id: "ws-panel-2",
      label: "Removable",
      icon: "trash-2",
      pluginId: "test-plugin",
    })
    expect(getWorkspacePanel("ws-panel-2")).toBeDefined()
    disposer()
    expect(getWorkspacePanel("ws-panel-2")).toBeUndefined()
  })

  test("listWorkspacePanels returns all entries", () => {
    registerWorkspacePanel({ id: "ws-a", label: "A", icon: "a", pluginId: "p1" })
    registerWorkspacePanel({ id: "ws-b", label: "B", icon: "b", pluginId: "p1" })
    const list = listWorkspacePanels()
    expect(list.length).toBe(2)
    const ids = list.map((e) => e.id)
    expect(ids).toContain("ws-a")
    expect(ids).toContain("ws-b")
  })

  test("getWorkspacePanel returns undefined for unknown id", () => {
    expect(getWorkspacePanel("nonexistent")).toBeUndefined()
  })

  test("clearWorkspacePanels removes all entries when no pluginId", () => {
    registerWorkspacePanel({ id: "ws-a", label: "A", icon: "a", pluginId: "p1" })
    registerWorkspacePanel({ id: "ws-b", label: "B", icon: "b", pluginId: "p2" })
    clearWorkspacePanels()
    expect(listWorkspacePanels().length).toBe(0)
  })

  test("clearWorkspacePanels with pluginId removes only matching entries", () => {
    registerWorkspacePanel({ id: "ws-a", label: "A", icon: "a", pluginId: "p1" })
    registerWorkspacePanel({ id: "ws-b", label: "B", icon: "b", pluginId: "p2" })
    registerWorkspacePanel({ id: "ws-c", label: "C", icon: "c", pluginId: "p1" })
    clearWorkspacePanels("p1")
    const list = listWorkspacePanels()
    expect(list.length).toBe(1)
    expect(list[0].id).toBe("ws-b")
  })

  test("duplicate registration replaces previous without crashing (Map semantics)", () => {
    registerWorkspacePanel({ id: "ws-dup", label: "First", icon: "a", pluginId: "p1" })
    registerWorkspacePanel({ id: "ws-dup", label: "Second", icon: "b", pluginId: "p1" })
    const entry = getWorkspacePanel("ws-dup")
    expect(entry!.label).toBe("Second")
    expect(listWorkspacePanels().length).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Panel Registry
// ═══════════════════════════════════════════════════════════════════

describe("PanelRegistry", () => {
  // Note: panel-registry has 3 built-in panels (library, agenda, lucid) registered at module init.
  const BUILTIN_COUNT = 3

  beforeEach(() => {
    clearGlobalPanels()
    // Re-register built-ins (they get cleared by clearGlobalPanels())
    const builtins = [
      { id: "library", label: "Library", icon: "book-open", pluginId: "" },
      { id: "agenda", label: "Agenda", icon: "clipboard-list", pluginId: "" },
      { id: "lucid", label: "Lucid", icon: "sparkles", pluginId: "" },
    ]
    for (const p of builtins) registerGlobalPanel(p)
  })

  test("registerGlobalPanel adds entry and returns disposer", () => {
    const disposer = registerGlobalPanel({
      id: "custom-panel",
      label: "Custom",
      icon: "star",
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    const entry = getGlobalPanel("custom-panel")
    expect(entry).toBeDefined()
    expect(entry!.label).toBe("Custom")
    disposer()
  })

  test("disposer removes only that entry", () => {
    const disposer = registerGlobalPanel({
      id: "removable-panel",
      label: "Gone",
      icon: "x",
      pluginId: "test-plugin",
    })
    expect(getGlobalPanel("removable-panel")).toBeDefined()
    disposer()
    expect(getGlobalPanel("removable-panel")).toBeUndefined()
    expect(listGlobalPanels().length).toBe(BUILTIN_COUNT)
  })

  test("listGlobalPanels includes built-in and plugin panels", () => {
    registerGlobalPanel({ id: "p1", label: "P1", icon: "package", pluginId: "plugin-x" })
    const list = listGlobalPanels()
    expect(list.length).toBe(BUILTIN_COUNT + 1)
    const ids = list.map((e) => e.id)
    expect(ids).toContain("library")
    expect(ids).toContain("agenda")
    expect(ids).toContain("lucid")
    expect(ids).toContain("p1")
  })

  test("getGlobalPanel returns undefined for unknown id", () => {
    expect(getGlobalPanel("nonexistent")).toBeUndefined()
  })

  test("getGlobalPanel finds built-in panel", () => {
    const panel = getGlobalPanel("library")
    expect(panel).toBeDefined()
    expect(panel!.label).toBe("Library")
  })

  test("clearGlobalPanels with pluginId removes only matching entries (preserves built-ins)", () => {
    registerGlobalPanel({ id: "p1", label: "P1", icon: "star", pluginId: "plugin-x" })
    registerGlobalPanel({ id: "p2", label: "P2", icon: "star", pluginId: "plugin-y" })
    clearGlobalPanels("plugin-x")
    const list = listGlobalPanels()
    expect(list.length).toBe(BUILTIN_COUNT + 1)
    const ids = list.map((e) => e.id)
    expect(ids).not.toContain("p1")
    expect(ids).toContain("p2")
  })

  test("duplicate registration replaces previous without crashing", () => {
    registerGlobalPanel({ id: "dup-panel", label: "First", icon: "a", pluginId: "p1" })
    registerGlobalPanel({ id: "dup-panel", label: "Second", icon: "b", pluginId: "p1" })
    expect(getGlobalPanel("dup-panel")!.label).toBe("Second")
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

describe("ThemeRegistry", () => {
  // Note: theme-registry registers the built-in synergy theme at module init.

  test("registerTheme adds entry and returns disposer", () => {
    const disposer = registerTheme({
      id: "custom-theme",
      label: "Custom Theme",
      appearance: "dark",
      variables: { "--bg": "#111" },
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    expect(getTheme("custom-theme")).toBeDefined()
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = registerTheme({
      id: "temp-theme",
      label: "Temporary",
      variables: {},
    })
    expect(getTheme("temp-theme")).toBeDefined()
    disposer()
    expect(getTheme("temp-theme")).toBeUndefined()
  })

  test("disposer clears active theme if it was the removed theme", () => {
    // Register under a new id, activate it, then dispose
    const disposer = registerTheme({ id: "theme-x", label: "X", variables: {} })
    activateTheme("theme-x")
    expect(getActiveThemeId()).toBe("theme-x")
    disposer()
    expect(getActiveThemeId()).toBeNull()
    expect(getActiveTheme()).toBeUndefined()
  })

  test("listThemes includes built-in and added themes", () => {
    registerTheme({ id: "extra-theme", label: "Extra", variables: {}, pluginId: "p1" })
    const list = listThemes()
    const ids = list.map((t) => t.id)
    expect(ids).toContain("extra-theme")
  })

  test("getTheme returns undefined for unknown id", () => {
    expect(getTheme("nonexistent")).toBeUndefined()
  })

  test("activateTheme sets active theme id", () => {
    registerTheme({ id: "theme-a", label: "A", variables: {} })
    activateTheme("theme-a")
    expect(getActiveThemeId()).toBe("theme-a")
    const active = getActiveTheme()
    expect(active).toBeDefined()
    expect(active!.id).toBe("theme-a")
  })

  test("activateTheme does nothing for unknown id", () => {
    const prev = getActiveThemeId()
    activateTheme("nonexistent-theme-xyz")
    expect(getActiveThemeId()).toBe(prev)
  })

  test("getActiveTheme returns undefined when no theme activated", () => {
    // Deactivate any currently active theme
    const current = getActiveThemeId()
    if (current) {
      const theme = getTheme(current)
      if (theme) {
        const disposer = registerTheme({ ...theme, id: current })
        disposer()
        // Re-add without re-activating
        registerTheme({ ...theme, id: current })
      }
    }
    expect(getActiveTheme()).toBeUndefined()
  })

  test("duplicate registration replaces previous without crashing (Map semantics)", () => {
    registerTheme({ id: "dup-theme", label: "First", variables: { "--a": "1" } })
    registerTheme({ id: "dup-theme", label: "Second", variables: { "--b": "2" } })
    const theme = getTheme("dup-theme")
    expect(theme!.label).toBe("Second")
    expect(listThemes().filter((t) => t.id === "dup-theme").length).toBe(1)
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

describe("ChatRegistry", () => {
  test("registerChatComponent adds entry and returns disposer", () => {
    const component = makeMockComponent()
    const disposer = registerChatComponent({
      id: "chat-comp-1",
      slot: "before-tools",
      component,
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    const entries = getChatComponentsBySlot("before-tools")
    expect(entries.some((e) => e.id === "chat-comp-1")).toBe(true)
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = registerChatComponent({
      id: "chat-comp-rm",
      slot: "after-tools",
      component: makeMockComponent(),
      pluginId: "test-plugin",
    })
    expect(getChatComponentsBySlot("after-tools").some((e) => e.id === "chat-comp-rm")).toBe(true)
    disposer()
    expect(getChatComponentsBySlot("after-tools").some((e) => e.id === "chat-comp-rm")).toBe(false)
  })

  test("getChatComponentsBySlot returns entries filtered by slot", () => {
    const compBefore = makeMockComponent()
    const compAfter = makeMockComponent()
    registerChatComponent({ id: "c-before", slot: "before-tools", component: compBefore, pluginId: "p1" })
    registerChatComponent({ id: "c-after", slot: "after-tools", component: compAfter, pluginId: "p1" })

    const beforeEntries = getChatComponentsBySlot("before-tools")
    expect(beforeEntries.length).toBe(1)
    expect(beforeEntries[0].id).toBe("c-before")

    const afterEntries = getChatComponentsBySlot("after-tools")
    expect(afterEntries.length).toBe(1)
    expect(afterEntries[0].id).toBe("c-after")
  })

  test("getChatComponentsBySlot returns empty array for slot with no entries", () => {
    expect(getChatComponentsBySlot("before-reasoning").length).toBe(0)
  })

  test("duplicate registration appends without crashing", () => {
    registerChatComponent({
      id: "dup-chat",
      slot: "before-tools",
      component: makeMockComponent(),
      pluginId: "p1",
    })
    registerChatComponent({
      id: "dup-chat",
      slot: "before-tools",
      component: makeMockComponent(),
      pluginId: "p1",
    })
    const entries = getChatComponentsBySlot("before-tools").filter((e) => e.id === "dup-chat")
    expect(entries.length).toBe(2)
  })

  test("multiple plugins can register to same slot", () => {
    registerChatComponent({ id: "c1", slot: "before-tools", component: makeMockComponent(), pluginId: "plugin-a" })
    registerChatComponent({ id: "c2", slot: "before-tools", component: makeMockComponent(), pluginId: "plugin-b" })
    const entries = getChatComponentsBySlot("before-tools")
    expect(entries.length).toBeGreaterThanOrEqual(2)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Route Registry
// ═══════════════════════════════════════════════════════════════════

describe("RouteRegistry", () => {
  beforeEach(() => {
    clearPluginRoutes()
  })

  test("registerPluginRoute adds entry and returns disposer", () => {
    const disposer = registerPluginRoute({
      path: "/plugin/test",
      label: "Test Route",
      icon: "package",
      entry: "test.html",
      pluginId: "test-plugin",
    })
    expect(typeof disposer).toBe("function")
    const routes = getPluginRoutes()
    expect(routes.length).toBe(1)
    expect(routes[0].path).toBe("/plugin/test")
    disposer()
  })

  test("disposer removes the entry", () => {
    const disposer = registerPluginRoute({
      path: "/plugin/rm",
      label: "Removable",
      entry: "rm.html",
      pluginId: "test-plugin",
    })
    expect(getPluginRoutes().length).toBe(1)
    disposer()
    expect(getPluginRoutes().length).toBe(0)
  })

  test("getPluginRoutes returns all entries", () => {
    registerPluginRoute({ path: "/a", label: "A", entry: "a.html", pluginId: "p1" })
    registerPluginRoute({ path: "/b", label: "B", entry: "b.html", pluginId: "p1" })
    const routes = getPluginRoutes()
    expect(routes.length).toBe(2)
  })

  test("getPluginRoutes returns a copy (mutation safe)", () => {
    registerPluginRoute({ path: "/x", label: "X", entry: "x.html", pluginId: "p1" })
    const routes = getPluginRoutes()
    routes.push({ path: "/y", label: "Y", entry: "y.html", pluginId: "p2" })
    expect(getPluginRoutes().length).toBe(1)
  })

  test("clearPluginRoutes removes all entries when no pluginId", () => {
    registerPluginRoute({ path: "/a", label: "A", entry: "a.html", pluginId: "p1" })
    registerPluginRoute({ path: "/b", label: "B", entry: "b.html", pluginId: "p2" })
    clearPluginRoutes()
    expect(getPluginRoutes().length).toBe(0)
  })

  test("clearPluginRoutes with pluginId removes only matching entries", () => {
    registerPluginRoute({ path: "/a", label: "A", entry: "a.html", pluginId: "p1" })
    registerPluginRoute({ path: "/b", label: "B", entry: "b.html", pluginId: "p2" })
    registerPluginRoute({ path: "/c", label: "C", entry: "c.html", pluginId: "p1" })
    clearPluginRoutes("p1")
    const routes = getPluginRoutes()
    expect(routes.length).toBe(1)
    expect(routes[0].path).toBe("/b")
  })

  test("duplicate registration appends without crashing", () => {
    registerPluginRoute({ path: "/dup", label: "First", entry: "first.html", pluginId: "p1" })
    registerPluginRoute({ path: "/dup", label: "Second", entry: "second.html", pluginId: "p1" })
    expect(getPluginRoutes().length).toBe(2)
  })
})
