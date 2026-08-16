import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { electronMockState, registerElectronMock } from "./electron-mock"
import { registerBrowserCollaboratorMocks } from "./browser-collaborators-mock"

registerElectronMock()
registerBrowserCollaboratorMocks()

const { BrowserWebContentsControl } = await import("../src/browser-webcontents-control.js?real")

interface CommandRecord {
  method: string
  params: Record<string, unknown>
}

type DebuggerHandler = (method: string, params: Record<string, unknown>) => unknown

class MockDebugger extends EventEmitter {
  attached = false
  commands: CommandRecord[] = []
  constructor(private handler: DebuggerHandler) {
    super()
  }

  isAttached() {
    return this.attached
  }

  attach() {
    this.attached = true
  }

  detach() {
    this.attached = false
  }

  sendCommand(method: string, params?: Record<string, unknown>) {
    this.commands.push({ method, params: params ?? {} })
    return Promise.resolve(this.handler(method, params ?? {}))
  }
}

class MockContents extends EventEmitter {
  readonly inputEvents: Array<Record<string, unknown>> = []
  readonly insertedTexts: string[] = []
  loadedUrls: string[] = []
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null
  destroyed: boolean
  focused = 0
  debugger: MockDebugger

  constructor(options: { url?: string; title?: string; destroyed?: boolean; handler?: DebuggerHandler } = {}) {
    super()
    this.destroyed = options.destroyed ?? false
    this.debugger = new MockDebugger(
      options.handler ??
        ((method) => {
          if (method === "Runtime.evaluate") {
            return {
              result: { value: { url: options.url ?? "https://example.com", title: options.title ?? "Example" } },
            }
          }
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } }
          if (method === "Page.navigate") return {}
          return {}
        }),
    )
  }

  isDestroyed() {
    return this.destroyed
  }

  sendInputEvent(input: Record<string, unknown>) {
    this.inputEvents.push(input)
  }

  insertText(text: string) {
    this.insertedTexts.push(text)
  }

  focus() {
    this.focused++
  }

  async loadURL(url: string) {
    this.loadedUrls.push(url)
  }

  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
    this.windowOpenHandler = handler
  }
}

interface MockDiagnostics {
  stageFiles(
    files: Array<{ name: string; mimeType?: string; data: string }>,
  ): Promise<{ paths: string[]; cleanup(): Promise<void> }>
  respondToDialog(requestId: string, accept: boolean, promptText?: string): Promise<void>
  respondToFileChooser(
    requestId: string,
    files: Array<{ name: string; mimeType?: string; data: string }>,
  ): Promise<void>
  cancelDownload(id: string): Promise<void>
}

function createDiagnostics(): MockDiagnostics & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { dialog: [], chooser: [], download: [] }
  return {
    calls,
    async stageFiles(files) {
      return { paths: files.map((file) => `/staged/${file.name}`), cleanup: async () => undefined }
    },
    async respondToDialog(requestId, accept, promptText) {
      calls.dialog.push({ requestId, accept, promptText })
    },
    async respondToFileChooser(requestId, files) {
      calls.chooser.push({ requestId, files })
    },
    async cancelDownload(id) {
      calls.download.push(id)
    },
  }
}

function targetFor(contents: MockContents, diagnostics?: MockDiagnostics) {
  const state = {
    resized: [] as Array<{ width: number; height: number }>,
    blocked: [] as Array<{ url: string; reason: string }>,
  }
  const target = {
    pageId: "page-1",
    contents: () => contents,
    diagnostics: () => diagnostics,
    resize: (width: number, height: number) => state.resized.push({ width, height }),
    pageState: () => ({
      id: "page-1",
      url: "https://example.com",
      title: "Example",
      isLoading: false,
      lastActiveAt: null,
    }),
    onNavigationBlocked: (url: string, reason: string) => state.blocked.push({ url, reason }),
    state,
  }
  return target
}

describe("Browser WebContents control", () => {
  test("dispatches resize, text, mouse, and key input through webContents", () => {
    const contents = new MockContents()
    const target = targetFor(contents)
    const control = new BrowserWebContentsControl(target as never)

    control.dispatchInput({ type: "input.resize", width: "800", height: 0 })
    expect(target.state.resized).toEqual([{ width: 800, height: 1 }])

    control.dispatchInput({ type: "input.text", text: "hello" })
    expect(contents.insertedTexts).toEqual(["hello"])
    expect(contents.focused).toBe(1)

    control.dispatchInput({ type: "input.mouse", action: "down", x: 3, y: 4, button: "right" })
    control.dispatchInput({ type: "input.mouse", action: "wheel", x: 5, y: 6, deltaX: 1, deltaY: 2 })
    control.dispatchInput({ type: "input.key", action: "down", key: "Enter", modifiers: ["Shift"] })
    expect(contents.inputEvents.map((event) => event.type)).toEqual(["mouseDown", "mouseWheel", "keyDown"])
    const keyEvent = contents.inputEvents[2] as { modifiers: string[] }
    expect(keyEvent.modifiers).toContain("shift")

    contents.destroyed = true
    expect(() => control.dispatchInput({ type: "input.text", text: "x" })).toThrow("webContents is unavailable")
  })

  test("routes dialog, file chooser, and download commands through diagnostics", async () => {
    const contents = new MockContents()
    const diagnostics = createDiagnostics()
    const control = new BrowserWebContentsControl(targetFor(contents, diagnostics) as never)

    await control.execute({ type: "dialog.respond", requestId: "dialog-1", accept: true, promptText: "yes" })
    expect(diagnostics.calls.dialog).toEqual([{ requestId: "dialog-1", accept: true, promptText: "yes" }])

    await control.execute({
      type: "filechooser.select",
      requestId: "chooser-1",
      files: [{ name: "a.txt", mimeType: "text/plain", dataBase64: "aGVsbG8=" }],
    })
    expect(diagnostics.calls.chooser).toEqual([
      { requestId: "chooser-1", files: [{ name: "a.txt", mimeType: "text/plain", data: "aGVsbG8=" }] },
    ])

    await control.execute({ type: "download.cancel", id: "download-1" })
    expect(diagnostics.calls.download).toEqual(["download-1"])
  })

  test("navigates through the CDP controller with user settle semantics", async () => {
    const contents = new MockContents()
    const control = new BrowserWebContentsControl(targetFor(contents) as never)

    const result = await control.execute({ type: "navigate", url: "https://example.com", source: "user" })

    expect(result).toMatchObject({ type: "navigation", settleReason: "none" })
    const navigate = contents.debugger.commands.find((command) => command.method === "Page.navigate")
    expect(navigate?.params).toEqual({ url: "https://example.com" })
  })

  test("requires a checkpoint target for restore commands", async () => {
    const contents = new MockContents()
    const control = new BrowserWebContentsControl(targetFor(contents) as never)

    await expect(control.execute({ type: "checkpoint", action: "restore" } as never)).rejects.toThrow(
      "checkpoint is required for restore.",
    )
  })

  test("applies viewport emulation through the controller", async () => {
    const contents = new MockContents()
    const target = targetFor(contents)
    const control = new BrowserWebContentsControl(target as never)

    const result = await control.execute({ type: "setViewport", width: 640, height: 480 })

    expect(result).toMatchObject({ type: "page" })
    const emulation = contents.debugger.commands.find(
      (command) => command.method === "Emulation.setDeviceMetricsOverride",
    )
    expect(emulation?.params).toMatchObject({ width: 640, height: 480 })
  })

  test("surfaces a navigation denial as a protocol error after the in-flight command", async () => {
    let resolveNavigate: ((value: unknown) => void) | null = null
    const contents = new MockContents({
      handler: (method) => {
        if (method === "Runtime.evaluate") return { result: { value: { url: "https://example.com", title: "" } } }
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } }
        if (method === "Page.navigate") return new Promise((resolve) => (resolveNavigate = resolve))
        return {}
      },
    })
    const target = targetFor(contents)
    const control = new BrowserWebContentsControl(target as never)

    const pending = control.execute({ type: "navigate", url: "https://example.com", source: "user" })
    await Bun.sleep(0)
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true
      },
    }
    contents.emit("will-navigate", event, "file:///etc/passwd")
    expect(target.state.blocked).toHaveLength(1)
    expect(target.state.blocked[0]!.url).toBe("file:///etc/passwd")

    resolveNavigate!({})
    await expect(pending).rejects.toMatchObject({ code: "browser_navigation_denied" })
  })

  test("opens http popups inside the same view and reports denied popups", async () => {
    const contents = new MockContents()
    const target = targetFor(contents)
    new BrowserWebContentsControl(target as never)
    contents.emit("did-navigate", {}, "https://example.com")

    expect(contents.windowOpenHandler!({ url: "https://example.com/next" })).toEqual({ action: "deny" })
    await Bun.sleep(0)
    expect(contents.loadedUrls).toEqual(["https://example.com/next"])

    expect(contents.windowOpenHandler!({ url: "file:///etc/passwd" })).toEqual({ action: "deny" })
    expect(target.state.blocked).toHaveLength(1)
  })

  test("keeps dispatching commands after gesture events fire", async () => {
    const contents = new MockContents()
    const control = new BrowserWebContentsControl(targetFor(contents) as never)
    contents.emit("before-mouse-event", {}, { type: "mouseDown" })
    contents.emit("before-input-event", {}, { type: "keyDown" })

    const first = await control.execute({ type: "navigate", url: "https://example.com", source: "user" })
    expect(first.type).toBe("navigation")
  })

  test("disposes listeners, handlers, and the debugger attachment", async () => {
    const contents = new MockContents()
    const control = new BrowserWebContentsControl(targetFor(contents) as never)
    await control.execute({ type: "navigate", url: "https://example.com", source: "user" })
    const before = contents.debugger.listenerCount("message")

    await control.dispose()

    expect(contents.debugger.listenerCount("message")).toBeLessThan(before)
    expect(contents.debugger.attached).toBe(false)
    expect(contents.windowOpenHandler!({ url: "https://example.com" })).toEqual({ action: "deny" })
    expect(contents.listenerCount("will-navigate")).toBe(0)
    expect(contents.listenerCount("will-redirect")).toBe(0)
    expect(contents.listenerCount("did-navigate")).toBe(0)
  })

  test("rejects commands when the target contents are destroyed", async () => {
    const contents = new MockContents()
    const control = new BrowserWebContentsControl(targetFor(contents) as never)
    contents.destroyed = true

    await expect(control.execute({ type: "navigate", url: "https://example.com", source: "user" })).rejects.toThrow(
      "webContents is unavailable",
    )
  })

  test("writes clipboard text through the electron clipboard adapter", async () => {
    electronMockState.clipboardWrites = []
    const contents = new MockContents()
    const control = new BrowserWebContentsControl(targetFor(contents) as never)

    await control.execute({ type: "clipboard", action: "write", text: "copy me" })

    expect(electronMockState.clipboardWrites).toEqual(["copy me"])
  })
})

describe("Browser WebContents control input normalization", () => {
  test("drops unknown key actions and falls back to left mouse events", () => {
    const contents = new MockContents()
    const control = new BrowserWebContentsControl(targetFor(contents) as never)

    control.dispatchInput({ type: "input.key", action: "repeat", key: "a" })
    expect(contents.inputEvents).toEqual([])

    control.dispatchInput({ type: "input.mouse", action: "hover", x: 1, y: 2 })
    const event = contents.inputEvents.at(-1) as { type: string; button: string }
    expect(event.button).toBe("left")
  })
})
