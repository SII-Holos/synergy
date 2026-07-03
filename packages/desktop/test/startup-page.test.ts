import { describe, expect, test } from "bun:test"
import { desktopErrorPage } from "../src/error-page.js"
import { isAllowedAppNavigation } from "../src/navigation-policy.js"
import { desktopStartupPage, startupStatusScript, startupThemeScript } from "../src/startup-page.js"

const mainSource = await Bun.file(new URL("../src/main.ts", import.meta.url)).text()
const preloadSource = await Bun.file(new URL("../src/preload.ts", import.meta.url)).text()
const startupOverlaySource = await Bun.file(new URL("../src/startup-overlay.ts", import.meta.url)).text()

function decodeDesktopHtml(url: string): string {
  expect(url.startsWith("data:text/html")).toBe(true)
  const body = url.slice(url.indexOf(",") + 1)
  return decodeURIComponent(body)
}

describe("desktop startup page", () => {
  test("renders a custom desktop shell before the app surface is ready", () => {
    const html = decodeDesktopHtml(
      desktopStartupPage({ chrome: "custom", iconDataUrl: "data:image/png;base64,c3luZXJneQ==", theme: "light" }),
    )

    expect(html).toContain("<title>Starting Synergy</title>")
    expect(html).toContain("img-src data:;")
    expect(html).toContain('class="startup-chrome"')
    expect(html).toContain('class="startup-center"')
    expect(html).toContain('class="startup-mark"')
    expect(html).toContain('data-window-action="minimize"')
    expect(html).toContain('data-window-action="maximize"')
    expect(html).toContain('data-window-action="close"')
    expect(html).toContain("Opening Synergy")
    expect(html).toContain("data:image/png;base64,c3luZXJneQ==")
    expect(html).not.toContain("file:///")
    expect(html).not.toContain('class="startup-sidebar"')
    expect(html).not.toContain('class="startup-composer"')
    expect(html).not.toContain('class="startup-topbar"')
  })

  test("uses the explicit resolved desktop theme instead of a fixed dark startup base", () => {
    const lightHtml = decodeDesktopHtml(desktopStartupPage({ chrome: "custom", theme: "light" }))
    const darkHtml = decodeDesktopHtml(desktopStartupPage({ chrome: "custom", theme: "dark" }))

    expect(lightHtml).toContain('data-startup-theme="light"')
    expect(lightHtml).toContain("color-scheme: light;")
    expect(darkHtml).toContain('data-startup-theme="dark"')
    expect(darkHtml).toContain("color-scheme: dark;")
    expect(lightHtml).toContain("--startup-bg: #FAFAFA;")
    expect(darkHtml).toContain("--startup-bg: #0F0F10;")
    expect(lightHtml).toContain("background: var(--startup-bg);")
    expect(lightHtml).not.toContain("background: #111214;")
    expect(mainSource).not.toContain('backgroundColor: "#111214"')
  })

  test("centers an animated icon splash instead of mirroring app layout", () => {
    const html = decodeDesktopHtml(desktopStartupPage({ chrome: "custom", theme: "light" }))

    expect(html).toContain("place-items: center;")
    expect(html).toContain("width: 96px;")
    expect(html).toContain("width: 72px;")
    expect(html).toContain("animation: startup-breathe")
    expect(html).toContain("@media (prefers-reduced-motion: reduce)")
    expect(html).not.toContain("startup-orbit")
    expect(html).not.toContain("startup-prompt-line")
  })

  test("renders the native titlebar spacer for macOS windows", () => {
    const html = decodeDesktopHtml(desktopStartupPage({ chrome: "native", theme: "dark" }))

    expect(html).toContain('class="startup-native-titlebar"')
    expect(html).not.toContain('<header class="startup-chrome">')
  })

  test("allows themed local startup and diagnostic pages before an app origin exists", () => {
    const errorHtml = decodeDesktopHtml(desktopErrorPage("Failed", "details", "light"))

    expect(isAllowedAppNavigation(desktopStartupPage({ chrome: "custom", theme: "light" }), null)).toBe(true)
    expect(isAllowedAppNavigation(desktopErrorPage("Failed", "details", "light"), null)).toBe(true)
    expect(errorHtml).toContain('data-error-theme="light"')
    expect(errorHtml).toContain("--error-bg: #FAFAFA")
    expect(errorHtml).toContain("background: var(--error-bg)")
    expect(errorHtml).not.toContain("background: #111214")
  })

  test("serializes status and theme updates for the loaded startup page", () => {
    expect(startupStatusScript({ title: "Loading workspace", detail: "Connecting to the local app surface." })).toBe(
      'window.synergySetStartupStatus?.({"title":"Loading workspace","detail":"Connecting to the local app surface."})',
    )
    expect(startupThemeScript("dark")).toBe('window.synergySetStartupTheme?.("dark")')
  })

  test("hosts the startup page in an overlay instead of the main app navigation", () => {
    expect(startupOverlaySource).toContain("new WebContentsView")
    expect(startupOverlaySource).toContain("window.contentView.addChildView(view)")
    expect(startupOverlaySource).toContain("startupStatusScript(status)")
    expect(startupOverlaySource).toContain("startupThemeScript(theme)")
    expect(startupOverlaySource).toContain("theme: this.options.theme")
    expect(startupOverlaySource).toContain("setTheme(theme")
    expect(startupOverlaySource).toContain("if (this.dismissed) return")
    expect(mainSource).toContain("new DesktopStartupOverlay")
    expect(mainSource).not.toContain("mainWindow.loadURL(\n    desktopStartupPage")
  })

  test("dismisses the startup overlay from an app-ready desktop bridge", () => {
    expect(preloadSource).toContain('ipcRenderer.invoke("desktop.startup.appReady")')
    expect(preloadSource).toContain("startup: desktopStartup")
    expect(mainSource).toContain('ipcMain.handle("desktop.startup.appReady"')
    expect(mainSource).toContain("event.sender !== mainWindow.webContents")
    expect(mainSource).toContain("await dismissStartupOverlay()")
  })

  test("dismisses the startup overlay after the app URL loads", () => {
    const loadIndex = mainSource.indexOf("await mainWindow.loadURL(targetURL)")
    const dismissIndex = mainSource.indexOf("await dismissStartupOverlay()", loadIndex)

    expect(loadIndex).toBeGreaterThanOrEqual(0)
    expect(dismissIndex).toBeGreaterThan(loadIndex)
  })
})
