import { describe, expect, test } from "bun:test"
import { electronMockState, registerElectronMock } from "./electron-mock"

registerElectronMock()

interface PendingInvocation {
  channel: string
  args: unknown[]
  result: unknown
}

const pendingInvocations: PendingInvocation[] = []

electronMockState.ipcInvoke = (channel, ...args) => {
  const index = pendingInvocations.findIndex(
    (entry) => entry.channel === channel && JSON.stringify(entry.args) === JSON.stringify(args),
  )
  if (index < 0) throw new Error(`Unexpected invoke ${channel}`)
  const [match] = pendingInvocations.splice(index, 1)
  return Promise.resolve(match!.result)
}

await import("../src/preload.js")

type SynergyDesktop = {
  platform: string
  openDirectoryPickerDialog: (opts?: { title?: string; multiple?: boolean }) => Promise<unknown>
  server: { status(): Promise<unknown>; restart(): Promise<unknown> }
  update: {
    status(): Promise<unknown>
    setMode(mode: unknown): Promise<unknown>
    check(input?: unknown): Promise<unknown>
    download(): Promise<unknown>
    installAndRestart(): Promise<unknown>
    onEvent(listener: (event: unknown) => void): () => void
  }
  shell: { openExternal(url: string): Promise<unknown> }
  clipboard: { writeText(text: string): Promise<unknown> }
  startup: { appReady(): Promise<unknown> }
  theme: {
    get(): Promise<unknown>
    set(input: unknown): Promise<unknown>
    setSource(source: unknown): Promise<unknown>
    onEvent(listener: (event: unknown) => void): () => void
  }
  window: {
    chrome: string
    minimize(): Promise<unknown>
    toggleMaximize(): Promise<unknown>
    close(): Promise<unknown>
    state(): Promise<unknown>
    onEvent(listener: (event: unknown) => void): () => void
  }
  badge: { setState(state: unknown): Promise<unknown> }
  browserNative: {
    attachView(input: unknown): Promise<unknown>
    detachView(input: unknown): Promise<unknown>
    focusView(input: unknown): Promise<unknown>
    resizeView(input: unknown): Promise<unknown>
    retryPage(input: unknown): Promise<unknown>
    presentationCapability(input: unknown): Promise<unknown>
    createPresentationTicket(input: unknown): Promise<unknown>
    onEvent(listener: (event: unknown) => void): () => void
  }
}

const desktop = electronMockState.exposed.synergyDesktop as unknown as SynergyDesktop

function expectInvoke<T>(channel: string, args: unknown[], result: T) {
  pendingInvocations.push({ channel, args, result })
}

describe("desktop preload bridge", () => {
  test("exposes the desktop platform with server and shell surfaces", async () => {
    expect(desktop.platform).toBe("desktop")

    expectInvoke("desktop.server.status", [], { mode: "managed" })
    expect(await desktop.server.status()).toEqual({ mode: "managed" })

    expectInvoke("desktop.server.restart", [], { mode: "managed" })
    expect(await desktop.server.restart()).toEqual({ mode: "managed" })

    expectInvoke("desktop.shell.openExternal", ["https://example.com"], undefined)
    await desktop.shell.openExternal("https://example.com")

    expectInvoke("desktop.clipboard.writeText", ["copy"], true)
    expect(await desktop.clipboard.writeText("copy")).toBe(true)
  })

  test("routes update and startup operations through IPC", async () => {
    expectInvoke("desktop.update.status", [], { phase: "idle" })
    expect(await desktop.update.status()).toEqual({ phase: "idle" })

    expectInvoke("desktop.update.setMode", ["manual"], undefined)
    await desktop.update.setMode("manual")

    expectInvoke("desktop.update.check", [{ manual: true }], undefined)
    await desktop.update.check({ manual: true })
    expectInvoke("desktop.update.check", [{}], undefined)
    await desktop.update.check()

    expectInvoke("desktop.update.download", [], undefined)
    await desktop.update.download()
    expectInvoke("desktop.update.installAndRestart", [], undefined)
    await desktop.update.installAndRestart()

    expectInvoke("desktop.startup.appReady", [], true)
    expect(await desktop.startup.appReady()).toBe(true)
  })

  test("maps the directory picker response to single or multiple selection shapes", async () => {
    expectInvoke("dialog:select-directory", [{ title: "Pick", multiple: false }], {
      canceled: false,
      directoryPaths: ["/one"],
    })
    expect(await desktop.openDirectoryPickerDialog({ title: "Pick" })).toBe("/one")

    expectInvoke("dialog:select-directory", [{ title: undefined, multiple: true }], {
      canceled: false,
      directoryPaths: ["/one", "/two"],
    })
    expect(await desktop.openDirectoryPickerDialog({ multiple: true })).toEqual(["/one", "/two"])

    expectInvoke("dialog:select-directory", [{ title: undefined, multiple: true }], {
      canceled: true,
      directoryPaths: ["/ignored"],
    })
    expect(await desktop.openDirectoryPickerDialog({ multiple: true })).toBeNull()
  })

  test("forwards theme and window state operations and subscribes to events", async () => {
    expectInvoke("desktop.theme.get", [], { version: 2 })
    expect(await desktop.theme.get()).toEqual({ version: 2 })

    const skin = { version: 2, source: "dark" }
    expectInvoke("desktop.theme.set", [skin], { version: 2 })
    expect(await desktop.theme.set(skin)).toEqual({ version: 2 })

    expectInvoke("desktop.theme.setSource", ["system"], { version: 2 })
    expect(await desktop.theme.setSource("system")).toEqual({ version: 2 })

    const themeEvents: unknown[] = []
    const offTheme = desktop.theme.onEvent((event) => themeEvents.push(event))
    const themeListener = electronMockState.ipcListeners.find((entry) => entry.channel === "desktop-theme:event")
    expect(themeListener).toBeDefined()
    themeListener!.wrapped(null, { type: "theme" })
    expect(themeEvents).toEqual([{ type: "theme" }])
    offTheme()
    expect(
      electronMockState.ipcListeners.some(
        (entry) => entry.channel === "desktop-theme:event" && entry.wrapped === themeListener!.wrapped,
      ),
    ).toBe(false)

    expectInvoke("desktop.window.minimize", [], undefined)
    await desktop.window.minimize()
    expectInvoke("desktop.window.toggleMaximize", [], { maximized: true, fullscreen: false, focused: true })
    expect(await desktop.window.toggleMaximize()).toEqual({ maximized: true, fullscreen: false, focused: true })
    expectInvoke("desktop.window.close", [], undefined)
    await desktop.window.close()
    expectInvoke("desktop.window.state", [], { maximized: false, fullscreen: false, focused: false })
    expect(await desktop.window.state()).toEqual({ maximized: false, fullscreen: false, focused: false })

    const windowEvents: unknown[] = []
    desktop.window.onEvent((event) => windowEvents.push(event))
    const windowListener = electronMockState.ipcListeners.find((entry) => entry.channel === "desktop-window:event")
    windowListener!.wrapped(null, { type: "state", state: { maximized: true, fullscreen: false, focused: true } })
    expect(windowEvents).toEqual([{ type: "state", state: { maximized: true, fullscreen: false, focused: true } }])
  })

  test("parses browser native events through the shared schema", () => {
    const events: unknown[] = []
    desktop.browserNative.onEvent((event) => events.push(event))
    const nativeListener = electronMockState.ipcListeners.find((entry) => entry.channel === "browser-native:event")

    nativeListener!.wrapped(null, { type: "bogus" })
    expect(events).toEqual([])

    nativeListener!.wrapped(null, {
      type: "native.loaded",
      protocolVersion: 2,
      pageId: "p1",
      url: "https://example.com",
    })
    expect(events).toEqual([{ type: "native.loaded", protocolVersion: 2, pageId: "p1", url: "https://example.com" }])
  })

  test("routes browser native control invocations", async () => {
    const attach = { ownerKey: "o", pageId: "p" }
    expectInvoke("browserNative.attach", [attach], undefined)
    await desktop.browserNative.attachView(attach)

    expectInvoke("browserNative.detach", [attach], undefined)
    await desktop.browserNative.detachView(attach)

    expectInvoke("browserNative.focus", [attach], undefined)
    await desktop.browserNative.focusView(attach)

    const resize = { ownerKey: "o", pageId: "p", bounds: { x: 0, y: 0, width: 800, height: 600 } }
    expectInvoke("browserNative.resize", [resize], undefined)
    await desktop.browserNative.resizeView(resize)

    expectInvoke("browserNative.retry", [attach], undefined)
    await desktop.browserNative.retryPage(attach)

    const capability = { serverUrl: "http://127.0.0.1:8765" }
    expectInvoke("browserNative.presentationCapability", [capability], { managedLocal: true })
    expect(await desktop.browserNative.presentationCapability(capability)).toEqual({ managedLocal: true })

    expectInvoke("browserNative.presentationTicket", [capability], { ok: true })
    expect(await desktop.browserNative.createPresentationTicket(capability)).toEqual({ ok: true })
  })

  test("sets the desktop badge through IPC", async () => {
    const state = { unread: 2 }
    expectInvoke("desktop.badge.setState", [state], undefined)
    await desktop.badge.setState(state)
  })
})
