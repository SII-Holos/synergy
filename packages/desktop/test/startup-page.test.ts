import { describe, expect, test } from "bun:test"
import { desktopErrorPage } from "../src/error-page.js"
import { isAllowedAppNavigation } from "../src/navigation-policy.js"
import { desktopStartupPage, startupStatusScript } from "../src/startup-page.js"

const mainSource = await Bun.file(new URL("../src/main.ts", import.meta.url)).text()

function decodeDesktopHtml(url: string): string {
  expect(url.startsWith("data:text/html")).toBe(true)
  const body = url.slice(url.indexOf(",") + 1)
  return decodeURIComponent(body)
}

describe("desktop startup page", () => {
  test("renders a custom desktop shell before the app surface is ready", () => {
    const html = decodeDesktopHtml(desktopStartupPage({ chrome: "custom", iconUrl: "file:///app/icon.png" }))

    expect(html).toContain("<title>Starting Synergy</title>")
    expect(html).toContain('class="startup-chrome"')
    expect(html).toContain('class="startup-shell"')
    expect(html).toContain('class="startup-sidebar"')
    expect(html).toContain('data-window-action="minimize"')
    expect(html).toContain('data-window-action="maximize"')
    expect(html).toContain('data-window-action="close"')
    expect(html).toContain("Opening Synergy")
    expect(html).toContain("Preparing the desktop shell.")
    expect(html).toContain("file:///app/icon.png")
  })

  test("uses the dark startup base before the saved Web theme is available", () => {
    const html = decodeDesktopHtml(desktopStartupPage({ chrome: "custom" }))

    expect(html).toContain("color-scheme: dark;")
    expect(html).toContain("--startup-background: #111214;")
    expect(mainSource).toContain('backgroundColor: "#111214"')
    expect(html).not.toContain("prefers-color-scheme: light")
  })

  test("centers the startup prompt on the same workbench measure as the app", () => {
    const html = decodeDesktopHtml(desktopStartupPage({ chrome: "custom" }))

    expect(html).toContain("justify-content: center;")
    expect(html).toContain("transform: translateY(clamp(24px, 5vh, 64px));")
    expect(html).toContain("width: min(54rem, 100%);")
  })

  test("renders the native titlebar spacer for macOS windows", () => {
    const html = decodeDesktopHtml(desktopStartupPage({ chrome: "native" }))

    expect(html).toContain('class="startup-native-titlebar"')
    expect(html).not.toContain('<header class="startup-chrome">')
  })

  test("allows local startup and diagnostic pages before an app origin exists", () => {
    expect(isAllowedAppNavigation(desktopStartupPage({ chrome: "custom" }), null)).toBe(true)
    expect(isAllowedAppNavigation(desktopErrorPage("Failed", "details"), null)).toBe(true)
  })

  test("serializes status updates for the loaded startup page", () => {
    expect(startupStatusScript({ title: "Loading workspace", detail: "Connecting to the local app surface." })).toBe(
      'window.synergySetStartupStatus?.({"title":"Loading workspace","detail":"Connecting to the local app surface."})',
    )
  })
})
