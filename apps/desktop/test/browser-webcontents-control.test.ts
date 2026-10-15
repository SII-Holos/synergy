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
    this.emit("before-mouse-event", {}, input)
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

test("native human input is coalesced and each Agent must observe before dispatching another effect", async () => {
  const contents = new MockContents({
    handler: (method) => {
      if (method === "Page.captureScreenshot") return { data: "aW1hZ2U=" }
      if (method === "Runtime.evaluate") return { result: { value: { x: 0, y: 0, width: 800, height: 600 } } }
      return {}
    },
  })
  const control = new BrowserWebContentsControl(targetFor(contents) as never)
  try {
    contents.emit("before-mouse-event", {}, { type: "mouseDown" })
    contents.emit("before-input-event", {}, { type: "keyDown", key: "a" })
    const effect = { type: "clipboard", action: "write", text: "effect" } as const
    await expect(control.execute(effect, "one")).rejects.toMatchObject({ code: "browser_page_changed_by_user" })
    const observed = await control.execute({ type: "screenshot" }, "one")
    expect(observed.userChanges).toContain("pointer: 1, keyboard: 1")
    await control.execute(effect, "one")
    await expect(control.execute(effect, "two")).rejects.toMatchObject({ code: "browser_page_changed_by_user" })
    await control.execute({ type: "reload", includeSnapshot: false, settleMode: "none" })
    await expect(control.execute(effect, "one")).rejects.toThrow("navigation: 1")
  } finally {
    await control.dispose()
  }
})

test("Agent-injected wheel input never becomes a human change", async () => {
  const contents = new MockContents()
  const control = new BrowserWebContentsControl(targetFor(contents) as never)
  try {
    await control.execute(
      {
        type: "action",
        action: {
          type: "scroll",
          target: { kind: "point", x: 12, y: 20 },
          deltaX: 0,
          deltaY: 100,
          settleMode: "none",
          includeSnapshot: false,
        },
      },
      "agent",
    )
    expect(contents.inputEvents.some((event) => event.type === "mouseWheel")).toBe(true)
    await control.execute({ type: "clipboard", action: "write", text: "allowed" }, "agent")
    contents.emit("before-mouse-event", {}, { type: "mouseWheel", x: 12, y: 20 })
    await expect(control.execute({ type: "clipboard", action: "write", text: "blocked" }, "agent")).rejects.toThrow(
      "scroll: 1",
    )
  } finally {
    await control.dispose()
  }
})

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
  test("ignores legacy resize input while dispatching text, mouse, and keys through webContents", () => {
    const contents = new MockContents()
    const target = targetFor(contents)
    const control = new BrowserWebContentsControl(target as never)

    control.dispatchInput({ type: "input.resize", width: "800", height: 0 })
    expect(target.state.resized).toEqual([])
    expect(contents.focused).toBe(0)
    expect(contents.debugger.commands).toEqual([])

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
    expect(emulation?.params).toMatchObject({ width: 640, height: 480, dontSetVisibleSize: true })
    expect(target.state.resized).toEqual([])
    await control.execute({ type: "setViewport", mode: "fit", width: 1, height: 1 })
    expect(
      contents.debugger.commands.some((command) => command.method === "Emulation.clearDeviceMetricsOverride"),
    ).toBe(true)
    expect(target.state.resized).toEqual([])
    expect(contents.focused).toBe(0)
  })

  test("hands the detached default viewport to native presentation without clearing explicit metrics", async () => {
    const contents = new MockContents()
    const target = targetFor(contents)
    const control = new BrowserWebContentsControl(target as never)
    const metrics = () => contents.debugger.commands.filter((command) => command.method.startsWith("Emulation."))

    await control.setNativeViewport({ width: 1280, height: 720 })
    expect(metrics().at(-1)).toMatchObject({
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 1280, height: 720, dontSetVisibleSize: false },
    })
    await control.setNativeViewport(null)
    expect(metrics().at(-1)?.method).toBe("Emulation.clearDeviceMetricsOverride")
    await control.execute({ type: "setViewport", width: 600, height: 400 })
    const fixed = metrics().length
    await control.setNativeViewport({ width: 800, height: 600 })
    await control.setNativeViewport(null)
    expect(metrics()).toHaveLength(fixed)
    await control.execute({ type: "setViewport", mode: "fit", width: 1, height: 1 })
    expect(metrics().at(-1)?.method).toBe("Emulation.clearDeviceMetricsOverride")
    await control.setNativeViewport({ width: 800, height: 600 })
    await control.execute({ type: "setViewport", width: 500, height: 300 })
    await control.execute({ type: "setViewport", mode: "fit", width: 1, height: 1 })
    expect(metrics().at(-1)).toMatchObject({
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 800, height: 600, dontSetVisibleSize: false },
    })
    expect(target.state.resized).toEqual([])
    expect(contents.focused).toBe(0)
    await control.dispose()
  })

  test("serializes a pending detached viewport before attachment and an explicit viewport command", async () => {
    let releaseInitial!: () => void
    const contents = new MockContents({
      handler: (method, params) => {
        if (method === "Emulation.setDeviceMetricsOverride" && params.width === 1280)
          return new Promise<void>((resolve) => (releaseInitial = resolve))
        if (method === "Runtime.evaluate") return { result: { value: { url: "about:blank", title: "" } } }
        return {}
      },
    })
    const control = new BrowserWebContentsControl(targetFor(contents) as never)
    const initial = control.setNativeViewport({ width: 1280, height: 720 })
    await Bun.sleep(0)
    const attach = control.setNativeViewport(null)
    const fixed = control.execute({ type: "setViewport", width: 600, height: 400 })
    expect(contents.debugger.commands.filter((command) => command.method.startsWith("Emulation."))).toHaveLength(1)
    releaseInitial()
    await Promise.all([initial, attach, fixed])
    expect(
      contents.debugger.commands
        .filter((command) => command.method.startsWith("Emulation."))
        .map(({ method, params }) => ({ method, width: params.width })),
    ).toEqual([
      { method: "Emulation.setDeviceMetricsOverride", width: 1280 },
      { method: "Emulation.clearDeviceMetricsOverride", width: undefined },
      { method: "Emulation.setDeviceMetricsOverride", width: 600 },
    ])
    await control.dispose()
  })

  test("finishes pending native viewport work before releasing the debugger attachment", async () => {
    let releaseViewport!: () => void
    const contents = new MockContents({
      handler: () => new Promise<void>((resolve) => (releaseViewport = resolve)),
    })
    const control = new BrowserWebContentsControl(targetFor(contents) as never)
    const viewport = control.setNativeViewport({ width: 1280, height: 720 })
    const disposal = control.dispose()
    await Bun.sleep(0)
    releaseViewport()
    await Promise.all([viewport, disposal])
    expect(contents.debugger.attached).toBe(false)
    expect(contents.debugger.listenerCount("message")).toBe(0)
  })

  test("allows only the adopted initial navigation and its redirects during viewport initialization", async () => {
    const initialURL = "https://accounts.example/start"
    let finishViewport!: (value: unknown) => void
    const contents = new MockContents({
      handler: (method) => {
        if (method === "Emulation.setDeviceMetricsOverride") {
          return new Promise((resolve) => (finishViewport = resolve))
        }
        if (method === "Runtime.evaluate") return { result: { value: { url: initialURL, title: "" } } }
        return {}
      },
    })
    const target = targetFor(contents)
    const control = new BrowserWebContentsControl({ ...target, initialNavigationURL: initialURL } as never)
    let subframePrevented = false
    contents.emit(
      "will-redirect",
      { preventDefault: () => (subframePrevented = true) },
      "https://frame.example/",
      false,
      false,
    )
    expect(subframePrevented).toBe(true)
    const pending = control.execute({ type: "setViewport", width: 640, height: 480 })
    await Bun.sleep(0)
    const prevented: string[] = []
    for (const [event, url] of [
      ["will-navigate", initialURL],
      ["will-redirect", "https://signin.example/login"],
      ["will-redirect", "https://callback.example/complete"],
    ]) {
      contents.emit(event!, { preventDefault: () => prevented.push(url!) }, url, false, true)
    }
    finishViewport({})
    try {
      await expect(pending).resolves.toMatchObject({ type: "page" })
      expect(prevented).toEqual([])
      const committedURL = "https://callback.example/complete"
      contents.emit("did-navigate", {}, committedURL)
      contents.emit("will-navigate", { preventDefault: () => prevented.push("same-origin") }, `${committedURL}/next`)
      contents.emit("will-redirect", { preventDefault: () => prevented.push("unsolicited") }, initialURL, false, true)
      expect(prevented).toEqual(["unsolicited"])
      expect(contents.focused).toBe(0)
      expect(contents.loadedUrls).toEqual([])
      expect(contents.debugger.commands.some((command) => command.method === "Page.navigate")).toBe(false)
    } finally {
      await control.dispose()
    }
  })

  test("does not lend the initial popup grant to unrelated navigation, popups, or unsafe protocols", async () => {
    const initialURL = "https://accounts.example/start"
    for (const destination of ["https://unsolicited.example/", "file:///etc/passwd", "custom:launch"]) {
      const contents = new MockContents()
      const target = targetFor(contents)
      const control = new BrowserWebContentsControl({
        ...target,
        initialNavigationURL: initialURL,
        onWindowOpen: () => ({ action: "allow" }),
      } as never)
      try {
        expect(contents.windowOpenHandler!({ url: destination })).toEqual({ action: "deny" })
        let prevented = false
        contents.emit("will-navigate", { preventDefault: () => (prevented = true) }, destination)
        expect(prevented).toBe(true)
      } finally {
        await control.dispose()
      }
    }
    for (const destination of ["file:///etc/passwd", "custom:launch"]) {
      const contents = new MockContents()
      const control = new BrowserWebContentsControl({
        ...targetFor(contents),
        initialNavigationURL: initialURL,
      } as never)
      let prevented = false
      contents.emit("will-redirect", { preventDefault: () => (prevented = true) }, destination, false, true)
      expect(prevented).toBe(true)
      await control.dispose()
    }
  })

  test("expires adopted navigation authority on cancellation and grants no authority to blank popups", async () => {
    for (const initialNavigationURL of ["https://accounts.example/start", "about:blank"]) {
      const contents = new MockContents()
      const control = new BrowserWebContentsControl({ ...targetFor(contents), initialNavigationURL } as never)
      if (initialNavigationURL !== "about:blank") contents.emit("did-stop-loading")
      let prevented = false
      contents.emit(
        "will-redirect",
        { preventDefault: () => (prevented = true) },
        "https://unsolicited.example/",
        false,
        true,
      )
      expect(prevented).toBe(true)
      await control.dispose()
    }
  })

  test("requires fresh human input or explicit Agent navigation after an adopted popup commits", async () => {
    const contents = new MockContents()
    const control = new BrowserWebContentsControl({
      ...targetFor(contents),
      initialNavigationURL: "https://accounts.example/start",
    } as never)
    contents.emit("did-navigate", {}, "https://signin.example/login")
    let prevented = false
    contents.emit("will-navigate", { preventDefault: () => (prevented = true) }, "https://other.example/")
    expect(prevented).toBe(true)
    await control.execute({
      type: "navigate",
      source: "agent",
      url: "https://authorized.example/",
      settleMode: "none",
      includeSnapshot: false,
    })
    prevented = false
    contents.emit(
      "will-redirect",
      { preventDefault: () => (prevented = true) },
      "https://authorized-redirect.example/",
      false,
      true,
    )
    expect(prevented).toBe(false)
    contents.emit("did-navigate", {}, "https://authorized-redirect.example/")
    contents.emit("will-navigate", { preventDefault: () => (prevented = true) }, "https://other.example/")
    expect(prevented).toBe(true)
    contents.emit("before-mouse-event", {}, { type: "mouseDown" })
    prevented = false
    contents.emit("will-navigate", { preventDefault: () => (prevented = true) }, "https://other.example/")
    expect(prevented).toBe(false)
    expect(contents.debugger.commands.find((command) => command.method === "Page.navigate")?.params.url).toBe(
      "https://authorized.example/",
    )
    expect(contents.focused).toBe(0)
    await control.dispose()
  })

  test("keeps popup authorization bounded to the opener gesture and never renews it during adoption", async () => {
    const now = Date.now
    let time = now()
    Date.now = () => time
    const parentContents = new MockContents()
    const childContents = new MockContents()
    const parent = new BrowserWebContentsControl({
      ...targetFor(parentContents),
      onWindowOpen: () => ({ action: "allow" }),
    } as never)
    const initialURL = "https://signin.example/login"
    let child: InstanceType<typeof BrowserWebContentsControl> | undefined
    try {
      parentContents.emit("did-navigate", {}, "https://accounts.example/")
      expect(parentContents.windowOpenHandler!({ url: initialURL })).toEqual({ action: "deny" })
      parentContents.emit("before-mouse-event", {}, { type: "mouseDown" })
      expect(parentContents.windowOpenHandler!({ url: initialURL })).toEqual({ action: "allow" })
      time += 2_001
      child = new BrowserWebContentsControl({ ...targetFor(childContents), initialNavigationURL: initialURL } as never)
      let prevented = false
      childContents.emit(
        "will-redirect",
        { preventDefault: () => (prevented = true) },
        "https://callback.example/",
        false,
        true,
      )
      expect(prevented).toBe(false)
      childContents.emit("did-navigate", {}, "https://callback.example/")
      childContents.emit("will-navigate", { preventDefault: () => (prevented = true) }, initialURL)
      expect(prevented).toBe(true)
      expect(parentContents.windowOpenHandler!({ url: initialURL })).toEqual({ action: "deny" })
      expect(parentContents.focused).toBe(0)
      expect(childContents.focused).toBe(0)
    } finally {
      Date.now = now
      await child?.dispose()
      await parent.dispose()
    }
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

  test("refuses unmanaged popups without navigating the source page", async () => {
    const contents = new MockContents()
    const target = targetFor(contents)
    new BrowserWebContentsControl(target as never)
    contents.emit("did-navigate", {}, "https://example.com")

    expect(contents.windowOpenHandler!({ url: "https://example.com/next" })).toEqual({ action: "deny" })
    await Bun.sleep(0)
    expect(contents.loadedUrls).toEqual([])

    expect(contents.windowOpenHandler!({ url: "file:///etc/passwd" })).toEqual({ action: "deny" })
    expect(target.state.blocked).toHaveLength(1)
  })

  test("allows human navigation while an agent observation is pending", async () => {
    let finish!: (value: unknown) => void
    let held = false
    const contents = new MockContents({
      handler: (method) => {
        if (method === "Runtime.evaluate" && !held) {
          held = true
          return new Promise((resolve) => {
            finish = resolve
          })
        }
        return { result: { value: { url: "https://example.com", title: "Example" } } }
      },
    })
    const target = targetFor(contents)
    const control = new BrowserWebContentsControl(target as never)
    contents.emit("did-navigate", {}, "https://example.com")
    const pending = control.execute({ type: "evaluate", expression: "document.title", mode: "trusted" })
    await Bun.sleep(0)
    contents.emit("before-mouse-event", {}, { type: "mouseDown" })
    let prevented = false
    contents.emit("will-navigate", { preventDefault: () => (prevented = true) }, "https://other.example/")
    finish({ result: { value: "Example" } })
    await pending
    expect(prevented).toBe(false)
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
    expect(contents.listenerCount("did-stop-loading")).toBe(0)
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
