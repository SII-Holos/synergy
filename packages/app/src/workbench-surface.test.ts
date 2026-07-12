import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const css = await Bun.file(new URL("./index.css", import.meta.url)).text()
const settingsCss = await Bun.file(new URL("./components/settings/settings-panel.css", import.meta.url)).text()
const agendaCss = await Bun.file(new URL("./components/agenda/agenda-dialog.css", import.meta.url)).text()
const agendaCalendar = await Bun.file(new URL("./components/agenda/calendar.tsx", import.meta.url)).text()
const agendaPanel = await Bun.file(new URL("./components/agenda/panel.tsx", import.meta.url)).text()
const marketplaceCss = await Bun.file(new URL("./plugin/marketplace/marketplace.css", import.meta.url)).text()
const libraryCss = await Bun.file(new URL("./components/library/library-panel.css", import.meta.url)).text()
const libraryPanel = await Bun.file(new URL("./components/library/library-panel.tsx", import.meta.url)).text()
const libraryShared = await Bun.file(new URL("./components/library/shared.tsx", import.meta.url)).text()
const questionPromptCss = await Bun.file(new URL("./components/session/question-prompt.css", import.meta.url)).text()
const questionPrompt = await Bun.file(new URL("./components/session/question-prompt.tsx", import.meta.url)).text()
const sidebarCss = await Bun.file(new URL("./components/sidebar/sidebar.css", import.meta.url)).text()
const nativeTitlebarCss = await Bun.file(
  new URL("./components/app-shell/desktop-native-titlebar.css", import.meta.url),
).text()
const nativeTitlebar = await Bun.file(
  new URL("./components/app-shell/desktop-native-titlebar.tsx", import.meta.url),
).text()
const sessionTopBarCss = await Bun.file(new URL("./components/top-bar/session-top-bar.css", import.meta.url)).text()
const sessionTopBar = await Bun.file(new URL("./components/top-bar/session-top-bar.tsx", import.meta.url)).text()
const sessionPage = await Bun.file(new URL("./pages/session.tsx", import.meta.url)).text()
const workbenchSurface = await Bun.file(new URL("./components/workspace/workbench-surface.tsx", import.meta.url)).text()
const workbenchSurfaceCss = await Bun.file(
  new URL("./components/workspace/workbench-surface.css", import.meta.url),
).text()
const workbenchPanels = await Bun.file(new URL("./context/workbench/index.tsx", import.meta.url)).text()
const builtinWorkbenchPanels = await Bun.file(
  new URL("./components/workspace/builtin-workbench-panels.tsx", import.meta.url),
).text()
const appSrc = fileURLToPath(new URL(".", import.meta.url))
const uiSrc = fileURLToPath(new URL("../../ui/src", import.meta.url))

function walkSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filepath = join(dir, entry.name)
    if (entry.isDirectory()) return walkSourceFiles(filepath)
    if (!/\.(css|ts|tsx)$/.test(filepath)) return []
    try {
      return statSync(filepath).isFile() ? [filepath] : []
    } catch {
      return []
    }
  })
}

function escapeClassName(className: string) {
  return `.${className.replace(/:/g, "\\:").replace(/\//g, "\\/")}`
}

describe("workbench surface polarity", () => {
  test("workbench surfaces derive from the shared theme instead of a local blue-gray ramp", () => {
    expect(css).toContain("--workbench-canvas-bg: var(--background-stronger);")
    expect(css).toContain("--workbench-card-bg: var(--surface-raised-base);")
    expect(css).toContain("--workbench-control-bg: var(--surface-inset-base);")
    expect(css).toContain("--workbench-input-bg: var(--input-base);")
    expect(css).toContain("--workbench-border: var(--border-weaker-base);")
    expect(css).toContain("--workbench-row-bg: color-mix(in srgb, var(--surface-raised-base) 84%, transparent);")
    expect(css).not.toContain("light-dark(rgb(240 241 244)")
    expect(css).not.toContain("--background-stronger: var(--workbench-canvas-bg);")
    expect(css).not.toContain("--surface-raised-base: var(--workbench-card-bg);")
  })

  test("opaque workbench mappings include common translucent surface utilities", () => {
    for (const className of [
      ".bg-surface-raised-base\\/80",
      ".bg-surface-inset-base\\/70",
      ".bg-surface-interactive-base\\/8",
      ".bg-background-base\\/55",
      ".hover\\:bg-surface-inset-base\\/40:hover",
    ]) {
      expect(css).toContain(className)
    }
  })

  test("workbench exposes a row primitive for list-like product surfaces", () => {
    expect(css).toContain(".workbench-row-surface")
    expect(css).toContain("background-color: var(--workbench-row-bg);")
    expect(css).toContain("box-shadow: inset 0 0 0 1px var(--workbench-border);")
  })

  test("settings consumes shared surface tokens instead of owning a local ramp", () => {
    expect(settingsCss).toContain("--settings-card-secondary-bg: var(--surface-base);")
    expect(settingsCss).toContain("--settings-popover-bg: var(--surface-raised-stronger-non-alpha);")
    expect(settingsCss).toContain("--workbench-card-secondary-bg: var(--settings-card-secondary-bg);")
    expect(settingsCss).toContain("--workbench-popover-bg: var(--settings-popover-bg);")
    expect(settingsCss).not.toContain("light-dark(rgb(")
    expect(settingsCss).not.toContain("--surface-raised-base: var(--settings-card-bg);")
    expect(settingsCss).not.toContain("--background-stronger: var(--settings-canvas-bg);")
  })

  test("feature workbenches consume shared primitives instead of page-local blue-gray ramps", () => {
    expect(marketplaceCss).toContain("--plugin-card-bg: var(--workbench-row-bg);")
    expect(marketplaceCss).toContain("--plugin-control-bg: var(--workbench-control-bg);")
    expect(libraryCss).toContain("--library-content-bg: var(--workbench-row-bg);")
    expect(libraryCss).toContain("--library-control-bg: var(--workbench-control-bg);")
    expect(agendaCss).toContain("--agenda-content-bg: var(--workbench-row-bg, var(--surface-raised-base));")
    expect(questionPromptCss).toContain("--question-content-bg: var(--workbench-row-bg, var(--surface-base));")
    expect(sidebarCss).toContain("--sb-bg: var(--background-base);")

    for (const source of [marketplaceCss, libraryCss, agendaCss, questionPromptCss, sidebarCss]) {
      expect(source).not.toContain("light-dark(rgb(")
    }
  })

  test("macOS native chrome keeps a narrow draggable header above the Holos sidebar", () => {
    expect(nativeTitlebar).toContain("desktopWindowNativeChromeActive(platform)")
    expect(nativeTitlebar).not.toContain('getSemanticIcon("app.sidebar")')
    expect(nativeTitlebar).not.toContain('getSemanticIcon("action.search")')
    expect(nativeTitlebarCss).toContain("position: relative;")
    expect(nativeTitlebarCss).toContain("flex: 0 0 var(--desktop-native-titlebar-height);")
    expect(nativeTitlebarCss).toContain("-webkit-app-region: drag;")
    expect(css).toContain("--desktop-native-titlebar-height: 18px;")
    expect(css).toContain("--desktop-native-titlebar-traffic-width: 90px;")
    expect(nativeTitlebarCss).toContain(".desktop-native-titlebar__traffic-space")
    expect(nativeTitlebarCss).toContain(".desktop-native-titlebar__drag-region")
    expect(sessionPage).toContain("session-workbench-pane")
    expect(sessionTopBar).not.toContain('import { Portal } from "solid-js/web"')
    expect(sessionTopBarCss).not.toContain(".app-shell--desktop-native-chrome .stb-root")
    expect(sessionTopBarCss).not.toContain(".app-shell--desktop-native-chrome.app-shell--sidebar-collapsed .stb-root")
    expect(sidebarCss).not.toContain(".app-shell--desktop-native-chrome .sb-header")
    expect(sidebarCss).not.toContain(".app-shell--desktop-native-chrome .sb-actions")
    expect(sidebarCss).not.toContain("--sb-native-titlebar-height")
  })

  test("workbench panel tabs keep close and add controls compact", () => {
    expect(builtinWorkbenchPanels.match(/cardinality: "singleton"/g)?.length).toBeGreaterThanOrEqual(3)
    expect(builtinWorkbenchPanels).toContain('id: "file"')
    expect(builtinWorkbenchPanels).toContain('cardinality: "multi"')
    expect(workbenchSurface).toContain("addablePanels")
    expect(workbenchSurface).toContain('panel.cardinality === "multi" || !openPanelIds.has(panel.id)')
    expect(workbenchSurface).toContain("const activePanel = createMemo")
    expect(workbenchSurface).toContain("when={activePanel()}")
    expect(workbenchSurface).toContain("keyed")
    expect(workbenchSurface).not.toContain('aria-label={isSide() ? "Close side workspace" : "Close BottomSpace"}')
    expect(workbenchSurfaceCss).toContain(".workbench-surface-tab:hover .workbench-surface-tab-close")
    expect(workbenchSurfaceCss).toContain("position: absolute;")
    expect(workbenchSurfaceCss).toContain("border-radius: 999px;")
    expect(workbenchSurfaceCss).toContain("pointer-events: none;")
    expect(workbenchSurfaceCss).toContain("var(--workbench-tab-bg)")
    expect(workbenchSurfaceCss).toContain(".workbench-surface-add-wrap")
    expect(workbenchSurface).toContain("<Popover")
    expect(workbenchSurface).toContain('aria-haspopup="menu"')
    expect(workbenchSurface).toContain("if (local.addOpen)")
    expect(workbenchSurfaceCss).toContain('.workbench-surface-add-menu [data-slot="popover-body"]')
    expect(builtinWorkbenchPanels).not.toContain("DialogSelectFile")
    expect(builtinWorkbenchPanels).toContain('return { title: "Open file", source: "explorer" }')
  })

  test("workbench surfaces close instead of persisting empty launchers", () => {
    expect(workbenchPanels).toContain("if (next.tabs.length === 0) target.close()")
  })

  test("raised stronger non-alpha utilities resolve to popover surfaces inside the workbench", () => {
    expect(css).toContain(".bg-surface-raised-stronger-non-alpha")
    expect(css).toContain("background-color: var(--workbench-popover-bg);")
    expect(css).not.toContain(
      ".bg-surface-raised-stronger-non-alpha\n  ) {\n  background-color: var(--workbench-card-bg);",
    )
  })

  test("agenda time grid uses centered labels and scoped line tokens", () => {
    expect(agendaCss).toContain("--agenda-grid-line: var(--border-weak-base)")
    expect(agendaCss).toContain("--agenda-grid-line-strong: var(--border-base)")
    expect(agendaCss).toContain(".agenda-time-label")
    expect(agendaCss).toContain("text-align: center;")
    expect(agendaCss).toContain("border-left: 1px solid var(--agenda-grid-line);")
    expect(agendaCss).toContain("border-top: 1px solid var(--agenda-grid-line);")
    expect(agendaCalendar).toContain("agenda-time-label")
    expect(agendaCalendar).toContain("const TIME_COL = 72")
    expect(agendaCalendar).not.toContain("right-3 text-10-medium text-text-weaker")
    expect(agendaCalendar).not.toContain("border-border-weaker-base/20")
    expect(agendaCalendar).not.toContain("border-border-weaker-base/28")
    expect(agendaCss).not.toContain("padding-left: 104px;")
    expect(agendaCss).not.toContain("padding-right: 12px;")
  })

  test("agenda detail popovers avoid nested card shells", () => {
    expect(agendaPanel).toContain("agenda-detail-section")
    expect(agendaPanel).toContain("agenda-run-row")
    expect(agendaCss).toContain(".agenda-detail-section")
    expect(agendaCss).toContain(".agenda-run-row")
    expect(agendaPanel).not.toContain("workbench-card-surface flex flex-col gap-3")
    expect(agendaPanel).not.toContain("workbench-control-surface overflow-hidden rounded-[1rem]")
  })

  test("library uses top-level tabs instead of a secondary icon sidebar", () => {
    expect(libraryPanel).toContain("<AppPanel.SegmentedNav")
    expect(libraryPanel).toContain("Overview")
    expect(libraryPanel).toContain("Memories")
    expect(libraryPanel).toContain("Experiences")
    expect(libraryPanel).toContain("Skills")
    expect(libraryPanel).not.toContain("<AppPanel.Nav>")
    expect(libraryPanel).not.toContain("AppPanel.NavItem")
    expect(libraryPanel).not.toContain('icon="activity"')
    expect(libraryPanel).not.toContain('icon="book-open"')
    expect(libraryPanel).not.toContain('icon="zap"')
    expect(libraryPanel).not.toContain('icon="sparkles"')

    expect(libraryCss).toContain(".library-header-controls")
    expect(libraryCss).toContain("--library-panel-bg")
    expect(libraryShared).toMatch(/export const libraryCardBaseClass\s*=\s*"library-card-surface/)
    expect(libraryShared).not.toContain("uppercase tracking-[0.16em]")
  })

  test("question prompts use a dedicated decision surface instead of a generic tool card", () => {
    expect(questionPrompt).toContain('<section class="question-prompt-shell"')
    expect(questionPrompt).toContain("question-prompt-option")
    expect(questionPrompt).toContain('class="question-prompt-option question-prompt-other-trigger"')
    expect(questionPrompt).toContain("question-prompt-skip")
    expect(questionPrompt).toContain("disabled={!currentAnswered()}")
    expect(questionPrompt).toContain("disabled={!allAnswered()}")
    expect(questionPrompt).not.toContain("Dismiss")
    expect(questionPrompt).not.toContain('Card variant="info"')
    expect(questionPrompt).not.toContain("workbench-card-surface workbench-card-surface-hover")

    expect(questionPromptCss).toContain("--question-shell-bg")
    expect(questionPromptCss).toContain("--question-content-bg")
    expect(questionPromptCss).toContain("--question-selected-bg")
    expect(questionPromptCss).toContain("border-radius: var(--radius-2xl);")
    expect(questionPromptCss).toContain(".question-prompt-option.is-picked")
    expect(questionPromptCss).toContain(".question-prompt-option-copy")
    expect(questionPromptCss).toContain(".question-prompt-footer")
  })

  test("generic surface utilities used by the frontend are covered by workbench mappings", () => {
    const sourceFiles = [...walkSourceFiles(appSrc), ...walkSourceFiles(uiSrc)]
    const genericBgClass = /(?:^|[\s"'`])((?:hover:)?bg-(?:surface|background|input|button)-[A-Za-z0-9\-/]+)/g
    const semanticState =
      /success|warning|critical|info|diff|action|brand|overlay|interactive-solid|interactive-weak|interactive-hover|muted|disabled/
    const missing = new Set<string>()

    for (const filepath of sourceFiles) {
      const source = readFileSync(filepath, "utf8")
      let match: RegExpExecArray | null
      while ((match = genericBgClass.exec(source))) {
        const className = match[1]
        if (semanticState.test(className)) continue
        const selector = escapeClassName(className)
        if (css.includes(selector) || css.includes(`${selector}:hover`)) continue
        missing.add(className)
      }
    }

    expect([...missing].sort()).toEqual([])
  })
})
