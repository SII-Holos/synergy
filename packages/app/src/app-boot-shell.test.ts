import { describe, expect, test } from "bun:test"

const html = await Bun.file(new URL("../index.html", import.meta.url)).text()
const entry = await Bun.file(new URL("./entry.tsx", import.meta.url)).text()
const app = await Bun.file(new URL("./app.tsx", import.meta.url)).text()
const themeContext = await Bun.file(new URL("../../ui/src/theme/context.tsx", import.meta.url)).text()

function blockBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  const endIndex = source.indexOf(end, startIndex)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex + end.length)
}

describe("app boot shell", () => {
  test("keeps the static boot surface outside the Solid root", () => {
    const bootIndex = html.indexOf('id="synergy-app-boot"')
    const rootIndex = html.indexOf('id="root"')

    expect(bootIndex).toBeGreaterThanOrEqual(0)
    expect(rootIndex).toBeGreaterThanOrEqual(0)
    expect(bootIndex).toBeLessThan(rootIndex)

    const rootBlock = blockBetween(html, '<div id="root"', "</div>")
    expect(rootBlock).not.toContain("synergy-app-boot")
  })

  test("uses literal fallback surfaces before app CSS loads", () => {
    const style = blockBetween(html, '<style id="synergy-app-boot-style">', "</style>")

    expect(style).toContain("#111214")
    expect(style).toContain("#24262a")
    expect(style).toContain("#synergy-app-boot")
    expect(style).not.toContain("--background-base")
    expect(style).not.toContain("var(")
  })

  test("hydrates the static boot theme from the saved app color scheme", () => {
    expect(html).toContain('localStorage.getItem("synergy-color-scheme")')
    expect(html).toContain('document.documentElement.setAttribute("data-synergy-color-scheme", mode)')
    expect(html).toContain('var isDark = scheme === "dark" || (scheme === "system" && systemDark)')
    expect(html).toContain('var fallbackScheme = desktopWindow ? "dark" : "system"')
  })

  test("renders a minimal animated icon splash instead of an app skeleton", () => {
    const style = blockBetween(html, '<style id="synergy-app-boot-style">', "</style>")

    expect(html).toContain('class="synergy-app-boot-mark"')
    expect(html).toContain("data-synergy-app-boot-icon")
    expect(style).toContain("place-items: center;")
    expect(style).toContain("animation: synergy-app-boot-breathe")
    expect(style).toContain("@media (prefers-reduced-motion: reduce)")
    expect(style).not.toContain("synergy-app-boot-orbit")
    expect(html).not.toContain("synergy-app-boot-sidebar")
    expect(html).not.toContain("synergy-app-boot-workbench")
    expect(html).not.toContain("synergy-app-boot-composer")
    expect(html).not.toContain("Loading app surface")
  })

  test("gates temporary desktop chrome on the desktop bridge", () => {
    expect(html).toContain("window.synergyDesktop && window.synergyDesktop.window")
    expect(html).toContain('html[data-synergy-desktop-chrome="custom"] .synergy-app-boot-chrome--custom')
    expect(html).toContain('html[data-synergy-desktop-chrome="native"] .synergy-app-boot-chrome--native')
    expect(html).toContain('data-synergy-app-boot-window-action="minimize"')
    expect(html).toContain('data-synergy-app-boot-window-action="maximize"')
    expect(html).toContain('data-synergy-app-boot-window-action="close"')
  })

  test("initializes the app theme from the saved color scheme before mount", () => {
    const initialSchemeIndex = themeContext.indexOf('const initialColorScheme = getSavedColorScheme() ?? "system"')
    const createStoreIndex = themeContext.indexOf("createStore({")

    expect(initialSchemeIndex).toBeGreaterThanOrEqual(0)
    expect(createStoreIndex).toBeGreaterThan(initialSchemeIndex)
    expect(themeContext).toContain("colorScheme: initialColorScheme")
    expect(themeContext).toContain("mode: resolveColorSchemeMode(initialColorScheme)")
    expect(themeContext).not.toContain('colorScheme: "system" as ColorScheme')
  })

  test("removes the boot shell only after the app surface leaves startup loading", () => {
    const listenerIndex = entry.indexOf(
      "window.addEventListener(APP_SURFACE_READY_EVENT, scheduleBootShellRemoval, { once: true })",
    )
    const renderIndex = entry.indexOf("render(")

    expect(listenerIndex).toBeGreaterThanOrEqual(0)
    expect(renderIndex).toBeGreaterThanOrEqual(0)
    expect(listenerIndex).toBeLessThan(renderIndex)
    expect(entry.match(/\bscheduleBootShellRemoval\b/g)).toHaveLength(2)
    expect(entry).toContain('document.getElementById("synergy-app-boot")?.remove()')
    expect(entry).toContain("window.requestAnimationFrame(remove)")
    expect(app).toContain('const APP_SURFACE_READY_EVENT = "synergy:app-surface-ready"')
    expect(app).toContain('if (view === "loading") return')
    expect(app).toContain("initialRouteWaitsForSessionSurface")
    expect(app).toContain("signalAppSurfaceReady()")
  })
})
