import { describe, expect, test } from "bun:test"

const html = await Bun.file(new URL("../index.html", import.meta.url)).text()
const entry = await Bun.file(new URL("./entry.tsx", import.meta.url)).text()
const app = await Bun.file(new URL("./app.tsx", import.meta.url)).text()
const themeContext = await Bun.file(new URL("../../ui/src/theme/context.tsx", import.meta.url)).text()
const desktopThemeSync = await Bun.file(new URL("./components/desktop-theme-sync.tsx", import.meta.url)).text()

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

  test("uses boot variables before app CSS loads", () => {
    const style = blockBetween(html, '<style id="synergy-app-boot-style">', "</style>")

    expect(style).toContain("--synergy-boot-bg")
    expect(style).toContain('html[data-synergy-color-scheme="light"]')
    expect(style).toContain('html[data-synergy-color-scheme="dark"]')
    expect(style).toContain("#synergy-app-boot")
    expect(style).toContain("background: var(--synergy-boot-bg)")
    expect(style).toContain("color: var(--synergy-boot-text)")
    expect(style).not.toContain("background: #111214")
    expect(style).not.toContain(
      "#synergy-app-boot {\n        position: fixed;\n        inset: 0;\n        z-index: 2147483647;\n        display: grid;\n        place-items: center;\n        overflow: hidden;\n        background: #111214",
    )
    expect(style).not.toContain("--background-base")
  })

  test("hydrates and syncs the static boot theme from the saved app color scheme", () => {
    expect(html).toContain('var fallbackScheme = "system"')
    expect(html).not.toContain('var fallbackScheme = desktopWindow ? "dark" : "system"')
    expect(html).toContain('localStorage.getItem("synergy-color-scheme")')
    expect(html).toContain('document.documentElement.setAttribute("data-synergy-color-scheme", mode)')
    expect(html).toContain('var isDark = scheme === "dark" || (scheme === "system" && systemDark)')
    expect(html).toContain("window.synergyDesktop?.theme?.set")
    expect(html).toContain("Promise.resolve(desktopThemeSet(scheme)).catch")
  })

  test("renders a minimal animated icon splash instead of an app skeleton", () => {
    const style = blockBetween(html, '<style id="synergy-app-boot-style">', "</style>")
    const splashMarkup = blockBetween(html, '<main class="synergy-app-boot-stage">', "</main>")

    expect(html).toContain('class="synergy-app-boot-mark"')
    expect(html).toContain("data-synergy-app-boot-icon")
    expect(style).toContain("place-items: center;")
    expect(style).toContain("width: 96px;")
    expect(style).toContain("width: 72px;")
    expect(style).toContain("animation: synergy-app-boot-breathe")
    expect(style).toContain("@media (prefers-reduced-motion: reduce)")
    expect(style).not.toContain("synergy-app-boot-orbit")
    expect(splashMarkup).not.toContain("src=")
    expect(html).toContain('icon.addEventListener("load", revealIcon, { once: true })')
    expect(html).toContain('icon.classList.add("is-loaded")')
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
    expect(themeContext).toContain("applyThemeCss(resolveColorSchemeMode(initialColorScheme))")
    expect(themeContext).not.toContain('colorScheme: "system" as ColorScheme')
    expect(themeContext).not.toContain("const savedScheme = getSavedColorScheme()")
  })

  test("maps the desktop theme bridge into platform and syncs app color scheme changes", () => {
    expect(entry).toContain('theme?: Platform["desktopTheme"]')
    expect(entry).toContain("desktopTheme: window.synergyDesktop?.theme")
    expect(app).toContain("<DesktopThemeSync />")
    expect(desktopThemeSync).toContain("platform.desktopTheme?.set(source)")
    expect(desktopThemeSync).toContain("theme.colorScheme()")
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
    const bootRemoveIndex = entry.indexOf('document.getElementById("synergy-app-boot")?.remove()')
    const desktopReadyIndex = entry.indexOf("window.synergyDesktop?.startup?.appReady?.()")
    expect(desktopReadyIndex).toBeGreaterThan(bootRemoveIndex)
    expect(app).toContain('const APP_SURFACE_READY_EVENT = "synergy:app-surface-ready"')
    expect(app).toContain('if (view === "loading") return')
    expect(app).toContain("initialRouteWaitsForSessionSurface")
    expect(app).toContain("signalAppSurfaceReady()")
  })
})
