import { describe, expect, test } from "bun:test"
import { MockElectronWindow, electronMockState, registerElectronMock } from "./electron-mock"
import {
  registerBrowserCollaboratorMocks,
  sharedControlState,
  sharedDiagnosticsState,
} from "./browser-collaborators-mock"

const windows: MockElectronWindow[] = []

registerElectronMock()
registerBrowserCollaboratorMocks()
electronMockState.windowBuilder = (options) => {
  const window = new MockElectronWindow(options as Record<string, unknown>)
  windows.push(window)
  return window
}

const { BrowserWebRTCHost } = await import("../src/browser-webrtc-host.js?real")
const { desktopThemeSnapshot, defaultDesktopSkinState } = await import("../src/theme.js")

function theme(mode: "light" | "dark") {
  return desktopThemeSnapshot(defaultDesktopSkinState(mode), mode === "dark")
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    ownerKey: "owner-1",
    serverUrl: "http://127.0.0.1:8765",
    ownerMode: "session" as const,
    sessionID: "session-1",
    pageId: "page-1",
    routeDirectory: "scopes/abc",
    theme: theme("dark"),
    emitBrokerEvent: () => undefined,
    ...overrides,
  }
}

async function startedHost(overrides: Record<string, unknown> = {}) {
  const events: unknown[] = []
  const host = new BrowserWebRTCHost(options({ emitBrokerEvent: (event: unknown) => events.push(event), ...overrides }))
  await host.start()
  return { host, events }
}

describe("Browser WebRTC host", () => {
  test("derives stable input and signaling channels from the owner and page identity", async () => {
    windows.length = 0
    const { host } = await startedHost()
    const inputChannel = electronMockState.ipcMainListeners.keys().next().value as string
    expect(inputChannel).toMatch(/^browser-host:[0-9a-f]{64}:input$/)
    expect(host.isAlive()).toBe(true)
  })

  test("creates an offscreen browser window and a controller window with display capture", async () => {
    windows.length = 0
    await startedHost()

    expect(windows).toHaveLength(2)
    expect(windows[0]!.options.webPreferences).toMatchObject({ offscreen: true, sandbox: true })
    expect(windows[1]!.options.webPreferences).toMatchObject({ nodeIntegration: true, sandbox: false })
    expect(windows[0]!.menuBarVisible).toBe(false)
  })

  test("emits page lifecycle events from browser window navigation", async () => {
    windows.length = 0
    const { events, host } = await startedHost()
    const contents = windows[0]!.webContents
    contents.loading = true
    contents.url = "https://example.com/start"
    contents.emit("did-start-loading")
    contents.loading = false
    contents.emit("did-stop-loading")
    contents.emit("did-navigate")
    contents.emit("did-navigate-in-page")
    contents.emit("did-fail-load", {}, -105, "unreachable", "https://example.com/fail")

    const types = events.map((event) => (event as { type: string }).type)
    expect(types).toContain("page.loading")
    expect(types).toContain("page.loaded")
    expect(types.filter((type) => type === "page.updated")).toHaveLength(2)
    const failure = events.find((event) => (event as { type: string }).type === "page.error") as {
      url: string
      message: string
    }
    expect(failure.url).toBe("https://example.com/fail")
    expect(failure.message).toBe("unreachable")
    expect(host.state().url).toBe("https://example.com/start")
  })

  test("routes valid remote input only from the controller sender and matching page", async () => {
    windows.length = 0
    electronMockState.ipcMainListeners.clear()
    const { host } = await startedHost()
    const inputChannel = [...electronMockState.ipcMainListeners.keys()].find((channel) => channel.endsWith(":input"))!
    const handlers = electronMockState.ipcMainListeners.get(inputChannel)!
    const rtcContents = windows[1]!.webContents

    const valid = { type: "input.mouse", action: "move", protocolVersion: 2, pageId: "page-1", x: 10, y: 12 }
    const handler = handlers.at(-1)!
    handler({ sender: rtcContents }, valid)
    handler({ sender: rtcContents }, { ...valid, pageId: "other-page" })
    handler({ sender: rtcContents }, { type: "bogus" })
    handler({ sender: { not: "rtc" } }, valid)

    expect(sharedControlState.instances.at(-1)!.dispatchInputs).toEqual([{ ...valid, button: "left", clickCount: 1 }])
  })

  test("forwards backend commands through the control and reports state", async () => {
    windows.length = 0
    const { host } = await startedHost()
    await host.execute({ type: "reload", source: "agent" } as never)
    expect(sharedControlState.instances.at(-1)!.commands).toEqual([{ type: "reload", source: "agent" }])
  })

  test("updates the theme on both windows and reconnects signaling on ticket changes", async () => {
    windows.length = 0
    const { host } = await startedHost()
    windows[1]!.webContents.sent.length = 0
    windows[1]!.webContents.destroyed = false

    host.setTheme(theme("light"))
    expect(windows[0]!.backgroundColor).toBe(theme("light").colors.background)
    expect(windows[1]!.backgroundColor).toBe(theme("light").colors.background)

    host.updateSignalingTicket("ticket-2")
    await Bun.sleep(0)
    const signaling = windows[1]!.webContents.sent.filter((entry) => entry.channel.endsWith(":signaling"))
    expect(signaling).toHaveLength(1)
    expect(String(signaling[0]!.payload)).toContain("ticket=ticket-2")
  })

  test("destroys windows, disposes collaborators, and removes input listeners", async () => {
    windows.length = 0
    const { host } = await startedHost()
    const inputChannel = [...electronMockState.ipcMainListeners.keys()].find((channel) => channel.endsWith(":input"))!

    await host.destroy()

    expect(host.isAlive()).toBe(false)
    expect(windows[0]!.destroyed).toBe(true)
    expect(windows[1]!.destroyed).toBe(true)
    expect(sharedControlState.instances.at(-1)!.disposeCalls).toBe(1)
    expect(sharedDiagnosticsState.instances.at(-1)!.disposeCalls).toBe(1)
    expect(electronMockState.ipcMainListeners.has(inputChannel)).toBe(false)
  })

  test("reports a destroyed page window as dead", async () => {
    windows.length = 0
    const { host } = await startedHost()
    windows[0]!.destroy()
    expect(host.isAlive()).toBe(false)
  })
})
