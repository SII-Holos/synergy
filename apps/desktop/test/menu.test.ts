import { afterEach, beforeEach, describe, expect, test } from "bun:test"

let platformDescriptor: PropertyDescriptor | undefined
let platform = process.platform

const { electronMockState, registerElectronMock } = await import("./electron-mock")
registerElectronMock()

const { installAppMenu } = await import("../src/menu.js")

function templateOf(index = 0) {
  return electronMockState.builtTemplates[index] as Array<{
    label?: string
    role?: string
    submenu?: Array<{ label?: string; click?: () => void }>
  }>
}

beforeEach(() => {
  // Re-patch process.platform on every test. The previous afterEach restored
  // the original descriptor, so a top-level-only patch would let later tests
  // read the real platform (linux on CI) and silently skip the darwin branch.
  platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")
  platform = process.platform
  Object.defineProperty(process, "platform", {
    configurable: true,
    get() {
      return platform
    },
  })

  electronMockState.applicationMenus = []
  electronMockState.builtTemplates = []
  electronMockState.aboutPanels = []
})

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor)
})

describe("desktop app menu", () => {
  test("installs no application menu on non-macOS platforms", () => {
    platform = "linux"

    installAppMenu({ channel: "dev", debug: true, getMainWindow: () => null })

    expect(electronMockState.applicationMenus).toEqual([null])
    expect(electronMockState.builtTemplates).toEqual([])
  })

  test("builds the macOS application menu with product identity and channel label", () => {
    platform = "darwin"

    installAppMenu({ channel: "dev", debug: false, getMainWindow: () => null })

    const template = templateOf()
    expect(template[0]).toMatchObject({ label: "Synergy" })
    expect(template.some((item) => item.role === "editMenu")).toBe(true)
    expect(template.some((item) => item.role === "windowMenu")).toBe(true)
    const help = template.find((item) => item.role === "help")
    expect(help?.submenu?.[0]).toMatchObject({ label: "Synergy dev", enabled: false })
    expect(electronMockState.applicationMenus).toHaveLength(1)
    expect(electronMockState.aboutPanels).toEqual([{ applicationName: "Synergy" }])
  })

  test("adds reload and devtools items only in debug mode", () => {
    platform = "darwin"

    installAppMenu({ channel: "stable", debug: true, getMainWindow: () => null })
    const view = templateOf().find((item) => item.label === "View")
    const labels = view?.submenu?.map((item) => item.label)
    expect(labels).toContain("Reload")
    expect(labels).toContain("Toggle Developer Tools")
    installAppMenu({ channel: "stable", debug: false, getMainWindow: () => null })
    const releaseView = templateOf(1).find((item) => item.label === "View")
    const releaseLabels = releaseView?.submenu?.map((item) => item.label)
    expect(releaseLabels).not.toContain("Reload")
    expect(releaseLabels).not.toContain("Toggle Developer Tools")
  })

  test("routes debug menu clicks to the main window webContents", () => {
    platform = "darwin"
    const webContents = {
      reloads: 0,
      devtoolsToggles: 0,
      reload() {
        this.reloads++
      },
      toggleDevTools() {
        this.devtoolsToggles++
      },
    }
    const window = { webContents }

    installAppMenu({
      channel: "dev",
      debug: true,
      getMainWindow: () => window as never,
    })

    const view = templateOf().find((item) => item.label === "View")
    const reload = view?.submenu?.find((item) => item.label === "Reload")
    const devtools = view?.submenu?.find((item) => item.label === "Toggle Developer Tools")
    reload?.click?.()
    devtools?.click?.()
    expect(webContents.reloads).toBe(1)
    expect(webContents.devtoolsToggles).toBe(1)

    installAppMenu({
      channel: "dev",
      debug: true,
      getMainWindow: () => null,
    })
    const nullView = templateOf(1).find((item) => item.label === "View")
    nullView?.submenu?.find((item) => item.label === "Reload")?.click?.()
  })
})
