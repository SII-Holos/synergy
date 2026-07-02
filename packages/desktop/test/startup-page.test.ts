import { describe, expect, test } from "bun:test"
import { desktopErrorPage } from "../src/error-page.js"
import { isAllowedAppNavigation } from "../src/navigation-policy.js"
import { desktopStartupPage, startupStatusScript } from "../src/startup-page.js"

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
    expect(html).toContain('data-window-action="minimize"')
    expect(html).toContain('data-window-action="maximize"')
    expect(html).toContain('data-window-action="close"')
    expect(html).toContain("Starting local workspace")
    expect(html).toContain("Preparing the desktop shell.")
    expect(html).toContain("file:///app/icon.png")
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
