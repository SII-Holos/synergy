import { describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"

const commands: unknown[] = []
const views: MockWebContentsView[] = []
const partitions: string[] = []
let currentBounds = { x: 0, y: 0, width: 0, height: 0 }
let resizePage: ((width: number, height: number) => void) | undefined
let failNewViews = false
let nextControlError: Error | null = null
let viewCreationAttempts = 0

class MockDebugger extends EventEmitter {
  attached = false
  rejectCommands = false

  isAttached() {
    return this.attached
  }

  attach() {
    this.attached = true
  }

  detach() {
    this.attached = false
  }

  async sendCommand() {
    if (this.rejectCommands) throw new Error("renderer unavailable")
    return { result: { value: 1 } }
  }
}

class MockWebContents extends EventEmitter {
  readonly session = { setProxy: async () => undefined }
  readonly debugger = new MockDebugger()
  url = "about:blank"
  destroyed = false
  reloads = 0
  stopped = 0

  async loadURL(url: string) {
    this.url = url
  }

  getURL() {
    return this.url
  }

  getTitle() {
    return ""
  }

  isLoading() {
    return false
  }

  isDestroyed() {
    return this.destroyed
  }

  isFocused() {
    return false
  }

  focus() {}

  stop() {
    this.stopped++
  }

  reload() {
    this.reloads++
  }

  close() {
    if (this.destroyed) return
    this.destroyed = true
    this.emit("destroyed")
  }
}

class MockWebContentsView {
  readonly webContents = new MockWebContents()
  visible = true

  constructor(options: { webPreferences?: { partition?: string } }) {
    viewCreationAttempts++
    if (failNewViews) throw new Error("view creation failed")
    views.push(this)
    partitions.push(options.webPreferences?.partition ?? "")
  }

  setBounds(value: { x: number; y: number; width: number; height: number }) {
    currentBounds = value
  }

  getBounds() {
    return currentBounds
  }

  setVisible(value: boolean) {
    this.visible = value
  }

  getVisible() {
    return this.visible
  }
}

const appEvents = new EventEmitter()
mock.module("electron", () => ({
  app: appEvents,
  WebContentsView: MockWebContentsView,
}))

mock.module("../src/browser-host-diagnostics.js", () => ({
  BrowserHostDiagnostics: class {
    async start() {}
    async dispose() {}
  },
}))

mock.module("../src/browser-webcontents-control.js", () => ({
  BrowserWebContentsControl: class {
    constructor(options: { resize(width: number, height: number): void }) {
      resizePage = options.resize
    }

    async execute(command: unknown) {
      if (nextControlError) {
        const error = nextControlError
        nextControlError = null
        throw error
      }
      commands.push(command)
      return { type: "void" }
    }

    async dispose() {}
  },
}))

const { BrowserNativePagePool } = await import("../src/browser-native-page-pool.js")

function input(ownerKey: string, emit: (event: any) => void = () => undefined) {
  return {
    ownerKey,
    page: { id: `page-${ownerKey}`, url: "https://example.com", title: "", isLoading: false, lastActiveAt: null },
    networkProxy: { server: "http://127.0.0.1:1234", username: "user", password: "password" },
    downloadDir: "/tmp",
    emit,
  }
}

async function until(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out")
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe("Browser native page pool", () => {
  test("sets a usable CSS viewport before the first navigation", async () => {
    commands.length = 0
    const pool = new BrowserNativePagePool()

    await pool.create(input("initial"))

    expect(commands.slice(0, 2)).toEqual([
      { type: "setViewport", width: 1280, height: 720 },
      { type: "navigate", url: "https://example.com", source: "user" },
    ])
    await pool.destroy()
  })

  test("viewport changes preserve the attached native view position", async () => {
    const pool = new BrowserNativePagePool()
    await pool.create(input("resize"))

    currentBounds = { x: 640, y: 96, width: 800, height: 600 }
    resizePage?.(1024, 768)

    expect(currentBounds).toEqual({ x: 640, y: 96, width: 1024, height: 768 })
    await pool.destroy()
  })

  test("replaces a crashed renderer generation while preserving page and profile identity", async () => {
    views.length = 0
    partitions.length = 0
    const events: any[] = []
    const pool = new BrowserNativePagePool({ recoveryDelaysMs: [0] })
    const handle = await pool.create(input("crash", (event) => events.push(event)))
    const first = views.at(-1)!

    first.webContents.emit("render-process-gone")
    await until(
      () => views.length === 2 && events.some((event) => event.type === "host.status" && event.status === "ready"),
    )

    expect(handle.state().id).toBe("page-crash")
    expect(partitions[0]).toBe(partitions[1])
    expect(events.filter((event) => event.type === "host.status").map((event) => event.status)).toEqual([
      "restarting",
      "ready",
    ])
    expect(first.webContents.destroyed).toBe(true)
    await pool.destroy()
  })

  test("uses one recovery flight for repeated renderer failure signals", async () => {
    views.length = 0
    const pool = new BrowserNativePagePool({ recoveryDelaysMs: [0] })
    await pool.create(input("single-flight"))
    const first = views.at(-1)!

    first.webContents.emit("render-process-gone")
    first.webContents.emit("destroyed")
    await until(() => views.length === 2)

    expect(views).toHaveLength(2)
    await pool.destroy()
  })

  test("returns a retryable restarting error and rebuilds after a typed CDP timeout", async () => {
    views.length = 0
    const pool = new BrowserNativePagePool({ recoveryDelaysMs: [0] })
    const handle = await pool.create(input("cdp-timeout"))
    nextControlError = new Error("CDP command Runtime.evaluate timed out after 5 seconds.")

    await expect(handle.execute({ type: "reload" })).rejects.toMatchObject({
      code: "browser_native_restarting",
      retryable: true,
    })
    await until(() => views.length === 2)

    expect(handle.isAlive()).toBe(true)
    await pool.destroy()
  })

  test("rebuilds after a sustained unresponsive renderer fails its CDP liveness probe", async () => {
    views.length = 0
    const pool = new BrowserNativePagePool({ recoveryDelaysMs: [0], unresponsiveGraceMs: 1 })
    await pool.create(input("unresponsive"))
    const first = views.at(-1)!
    first.webContents.debugger.rejectCommands = true

    first.webContents.emit("unresponsive")
    await until(() => views.length === 2)

    expect(first.webContents.destroyed).toBe(true)
    await pool.destroy()
  })

  test("turns a repeated main-document timeout into an explicit error without destroying a healthy renderer", async () => {
    views.length = 0
    const events: any[] = []
    const pool = new BrowserNativePagePool({ navigationTimeoutMs: 2 })
    await pool.create(input("navigation", (event) => events.push(event)))
    const contents = views.at(-1)!.webContents

    contents.emit("did-start-loading")
    await until(() => contents.reloads === 1)
    await until(() => events.some((event) => event.type === "page.error" && /automatic retry/.test(event.message)))

    expect(contents.stopped).toBe(2)
    expect(contents.destroyed).toBe(false)
    await pool.destroy()
  })

  test("enters failed after the recovery budget and supports an explicit retry", async () => {
    views.length = 0
    viewCreationAttempts = 0
    const events: any[] = []
    const pool = new BrowserNativePagePool({ recoveryDelaysMs: [0, 0, 0] })
    await pool.create(input("budget", (event) => events.push(event)))
    failNewViews = true
    views.at(-1)!.webContents.emit("render-process-gone")
    await until(() => events.some((event) => event.type === "host.status" && event.status === "failed"))
    expect(viewCreationAttempts).toBe(10)

    failNewViews = false
    await pool.retry("budget", "page-budget")

    expect(events.filter((event) => event.type === "host.status").at(-1)?.status).toBe("ready")
    await pool.destroy()
  })
})
