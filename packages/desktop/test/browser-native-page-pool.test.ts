import { describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"

const commands: unknown[] = []
const views: MockWebContentsView[] = []
const partitions: string[] = []
let currentBounds = { x: 0, y: 0, width: 0, height: 0 }
let resizePage: ((width: number, height: number) => void) | undefined
let failNewViews = false
let nextControlError: Error | null = null
let failDispose = false
let viewCreationAttempts = 0

class MockDebugger extends EventEmitter {
  attached = false
  rejectCommands = false
  attachCalls = 0
  detachCalls = 0

  isAttached() {
    return this.attached
  }

  attach() {
    this.attachCalls++
    this.attached = true
  }

  detach() {
    this.detachCalls++
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

  forcefullyCrashRenderer() {
    if (this.destroyed) return
    this.destroyed = true
    this.emit("destroyed")
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
    async dispose() {
      if (failDispose) throw new Error("diagnostics dispose failed")
    }
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

    async dispose() {
      if (failDispose) throw new Error("control dispose failed")
    }
  },
}))

import type { BrowserNativePageHandle } from "../src/browser-native-page-pool.js"

const { BrowserNativePagePool, MAX_RECOVERY_BUDGET } = await import("../src/browser-native-page-pool.js")

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
    let executeAtReady: Promise<unknown> | null = null
    let handle!: BrowserNativePageHandle
    const pool = new BrowserNativePagePool({ recoveryDelaysMs: [0] })
    handle = await pool.create(
      input("crash", (event) => {
        events.push(event)
        if (event.type === "host.status" && event.status === "ready") {
          // The ready event is the availability contract: a consumer reacting
          // to it must be able to issue CDP commands without racing the
          // restarting guard. Capturing the command synchronously from the
          // emit callback makes this test fail on the parent implementation,
          // where ready fired before the recovery guard cleared.
          executeAtReady = handle.execute({ type: "reload" })
        }
      }),
    )
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
    await expect(executeAtReady).resolves.toBeDefined()
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
    const budgetErrorIndex = events.findIndex(
      (event) => event.type === "page.error" && /could not recover after repeated attempts/.test(event.message),
    )
    const failedIndex = events.findIndex((event) => event.type === "host.status" && event.status === "failed")
    expect(budgetErrorIndex).toBeGreaterThanOrEqual(0)
    expect(failedIndex).toBeGreaterThan(budgetErrorIndex)

    failNewViews = false
    await pool.retry("budget", "page-budget")

    expect(events.filter((event) => event.type === "host.status").at(-1)?.status).toBe("ready")
    await pool.destroy()
  })

  test("close stays available in the failed state without starting another recovery", async () => {
    views.length = 0
    viewCreationAttempts = 0
    const events: any[] = []
    const pool = new BrowserNativePagePool({ recoveryDelaysMs: [0, 0, 0] })
    const handle = await pool.create(input("close-failed", (event) => events.push(event)))
    failNewViews = true
    views.at(-1)!.webContents.emit("render-process-gone")
    await until(() => events.some((event) => event.type === "host.status" && event.status === "failed"))
    const attemptsAtFailure = viewCreationAttempts

    failNewViews = false
    await expect(handle.execute({ type: "close" })).resolves.toEqual({ type: "void" })
    expect(viewCreationAttempts).toBe(attemptsAtFailure)
    await pool.destroy()
  })
  test("bounds the healthy-reload path so a wedged renderer cannot reload forever", async () => {
    views.length = 0
    const events: any[] = []
    const pool = new BrowserNativePagePool({ unresponsiveGraceMs: 1 })
    await pool.create(input("healthy-reload", (event) => events.push(event)))
    const contents = views.at(-1)!.webContents

    // Each unresponsive episode succeeds its CDP probe (healthy path), so the
    // pool reloads. Repeat until the shared recovery budget is exhausted.
    for (let i = 0; i <= MAX_RECOVERY_BUDGET; i++) {
      contents.emit("unresponsive")
      await until(
        () =>
          contents.reloads === i + 1 ||
          events.some((event) => event.type === "host.status" && event.status === "failed"),
      )
      if (events.some((event) => event.type === "host.status" && event.status === "failed")) break
      contents.emit("responsive")
    }

    await until(() => events.some((event) => event.type === "host.status" && event.status === "failed"))
    expect(contents.reloads).toBeLessThanOrEqual(MAX_RECOVERY_BUDGET)
    expect(events.filter((event) => event.type === "host.status" && event.status === "failed")).toHaveLength(1)
    expect(events.some((event) => event.type === "page.error" && /unresponsive/.test(event.message))).toBe(true)
    await pool.destroy()
  })
  test("resume on a healthy page returns state without replacing its generation", async () => {
    views.length = 0
    const pool = new BrowserNativePagePool({ recoveryDelaysMs: [0] })
    const handle = await pool.create(input("resume-healthy"))
    const initialView = views.at(-1)

    await expect(handle.execute({ type: "resume" })).resolves.toMatchObject({
      type: "page",
      page: { id: "page-resume-healthy" },
    })
    expect(views).toHaveLength(1)
    expect(views.at(-1)).toBe(initialView)
    await pool.destroy()
  })

  test("resume during recovery waits for the single flight and returns ready page state", async () => {
    views.length = 0
    const events: any[] = []
    const pool = new BrowserNativePagePool({ recoveryDelaysMs: [0] })
    const handle = await pool.create(input("resume-flight", (event) => events.push(event)))
    views.at(-1)!.webContents.emit("render-process-gone")

    await expect(handle.execute({ type: "resume" })).resolves.toMatchObject({
      type: "page",
      page: { id: "page-resume-flight" },
    })
    expect(views).toHaveLength(2)
    expect(events.filter((event) => event.type === "host.status").map((event) => event.status)).toEqual([
      "restarting",
      "ready",
    ])
    await pool.destroy()
  })

  test("resume retries a failed page without replaying the failed command", async () => {
    views.length = 0
    viewCreationAttempts = 0
    const events: any[] = []
    const pool = new BrowserNativePagePool({ recoveryDelaysMs: [0, 0, 0] })
    const handle = await pool.create(input("resume-failed", (event) => events.push(event)))
    failNewViews = true
    views.at(-1)!.webContents.emit("render-process-gone")
    await until(() => events.some((event) => event.type === "host.status" && event.status === "failed"))
    expect(viewCreationAttempts).toBe(10)

    failNewViews = false
    await expect(handle.execute({ type: "reload", source: "agent" })).rejects.toMatchObject({
      code: "browser_native_recovery_failed",
    })
    const attemptsBeforeResume = viewCreationAttempts
    await expect(handle.execute({ type: "resume" })).resolves.toMatchObject({
      type: "page",
      page: { id: "page-resume-failed" },
    })
    expect(viewCreationAttempts).toBeGreaterThan(attemptsBeforeResume)
    expect(handle.state().id).toBe("page-resume-failed")
    expect(events.filter((event) => event.type === "host.status").at(-1)?.status).toBe("ready")
    await pool.destroy()
  })

  test("does not reset the navigation retry budget on mid-navigation loading events", async () => {
    views.length = 0
    const events: any[] = []
    const pool = new BrowserNativePagePool({ navigationTimeoutMs: 2 })
    await pool.create(input("redirect-loop", (event) => events.push(event)))
    const contents = views.at(-1)!.webContents

    // A redirect fires multiple did-start-loading events; the retry counter
    // must survive them so the watchdog reloads only once.
    contents.emit("did-start-loading")
    contents.emit("did-start-loading")
    await until(() => contents.reloads === 1)
    contents.emit("did-start-loading")
    await until(() => events.some((event) => event.type === "page.error" && /automatic retry/.test(event.message)))

    expect(contents.reloads).toBe(1)
    expect(contents.destroyed).toBe(false)
    await pool.destroy()
  })

  test("stops rebuilding after the recovery budget even when new generations succeed", async () => {
    views.length = 0
    const events: any[] = []
    const pool = new BrowserNativePagePool({ recoveryDelaysMs: [0] })
    await pool.create(input("rebuild-loop", (event) => events.push(event)))

    // Each new generation immediately crashes, so every recovery round
    // rebuilds successfully but never reaches ready. The budget must still
    // stop the loop. Wait for each recovery flight to fully finish (ready)
    // before triggering the next crash, otherwise single-flight dedup swallows
    // the next signal.
    for (let i = 0; i < MAX_RECOVERY_BUDGET; i++) {
      views.at(-1)!.webContents.emit("render-process-gone")
      await until(() => events.filter((event) => event.type === "host.status").at(-1)?.status === "ready")
    }
    views.at(-1)!.webContents.emit("render-process-gone")
    await until(() => events.some((event) => event.type === "host.status" && event.status === "failed"))
    expect(views.length).toBeLessThanOrEqual(MAX_RECOVERY_BUDGET + 2)
    expect(events.filter((event) => event.type === "host.status" && event.status === "failed")).toHaveLength(1)
    await pool.destroy()
  })

  test("keeps a successful recovery when closing the previous generation fails", async () => {
    views.length = 0
    const events: any[] = []
    const pool = new BrowserNativePagePool({ recoveryDelaysMs: [0] })
    await pool.create(input("close-fail", (event) => events.push(event)))
    const first = views.at(-1)!

    failDispose = true
    first.webContents.emit("render-process-gone")
    await until(
      () => views.length === 2 && events.some((event) => event.type === "host.status" && event.status === "ready"),
    )
    failDispose = false

    // The replacement is active and ready despite the previous generation's
    // cleanup error; the recovery must not roll back or retry.
    expect(views).toHaveLength(2)
    expect(events.filter((event) => event.type === "host.status").map((event) => event.status)).toEqual([
      "restarting",
      "ready",
    ])
    await pool.destroy()
  })
})
