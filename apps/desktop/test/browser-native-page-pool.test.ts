import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { electronAppEmitter, electronMockState, registerElectronMock } from "./electron-mock"

const commands: unknown[] = []
const nativeViewports: Array<{ width: number; height: number } | null> = []
const views: MockWebContentsView[] = []
const partitions: string[] = []
let currentBounds = { x: 0, y: 0, width: 0, height: 0 }
let openPopup: ((details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse) | undefined
let failNewViews = false
let nextControlError: Error | null = null
let nextDiagnosticsError: Error | null = null
let failDispose = false
let viewCreationAttempts = 0
let captureOperation: (() => Promise<void>) | undefined

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
  title = ""
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
    return this.title
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

const appEvents = electronAppEmitter
registerElectronMock()
beforeEach(() => {
  electronMockState.viewBuilder = (options) =>
    new MockWebContentsView(options as Electron.WebContentsViewConstructorOptions)
})
afterEach(() => {
  electronMockState.viewBuilder = null
})

mock.module("../src/browser-host-diagnostics.js", () => ({
  BrowserHostDiagnostics: class {
    async start() {
      if (!nextDiagnosticsError) return
      const error = nextDiagnosticsError
      nextDiagnosticsError = null
      throw error
    }
    async dispose() {
      if (failDispose) throw new Error("diagnostics dispose failed")
    }
  },
}))

mock.module("../src/browser-webcontents-control.js", () => ({
  BrowserWebContentsControl: class {
    constructor(options: { onWindowOpen(details: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse }) {
      openPopup = options.onWindowOpen
    }

    async setNativeViewport(viewport: { width: number; height: number } | null) {
      nativeViewports.push(viewport)
    }

    async execute(command: unknown) {
      if (nextControlError) {
        const error = nextControlError
        nextControlError = null
        throw error
      }
      commands.push(command)
      if ((command as { type: string }).type === "screenshot") await captureOperation?.()
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
    profile: { id: ownerKey, partition: `persist:synergy-browser-${ownerKey}`, revision: 0 },
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
  test("leases one hidden native attachment for concurrent captures without undoing a human selection", async () => {
    const children = new Set<MockWebContentsView>()
    const window = {
      isDestroyed: () => false,
      contentView: {
        addChildView: (view: MockWebContentsView) => children.add(view),
        removeChildView: (view: MockWebContentsView) => children.delete(view),
      },
    }
    const pool = new BrowserNativePagePool({ captureWindow: () => window as never })
    const initial = input("capture")
    const page = await pool.create(initial)
    const view = views.at(-1)!
    const releases: Array<() => void> = []
    captureOperation = () => new Promise<void>((resolve) => releases.push(resolve))
    const first = page.execute({ type: "screenshot" })
    const second = page.execute({ type: "screenshot" })
    try {
      await until(() => releases.length === 2)
      expect(children.size).toBe(1)
      expect(view.getVisible()).toBe(false)
      releases[0]()
      await first
      expect(children.size).toBe(1)
      pool.attach(window as never, initial.ownerKey, initial.page.id)
      view.setVisible(true)
      releases[1]()
      await second
      expect(children.has(view)).toBe(true)
      expect(view.getVisible()).toBe(true)
      const third = page.execute({ type: "screenshot" })
      await until(() => releases.length === 3)
      pool.detach(window as never, initial.ownerKey, initial.page.id)
      expect(children.has(view)).toBe(true)
      expect(view.getVisible()).toBe(false)
      releases[2]()
      await third
      expect(children.size).toBe(0)
    } finally {
      for (const release of releases) release()
      await Promise.allSettled([first, second])
      captureOperation = undefined
      await pool.destroy()
    }
  })

  test("releases a failed background capture without retaining its view", async () => {
    const children = new Set<MockWebContentsView>()
    const window = {
      isDestroyed: () => false,
      contentView: {
        addChildView: (view: MockWebContentsView) => children.add(view),
        removeChildView: (view: MockWebContentsView) => children.delete(view),
      },
    }
    const pool = new BrowserNativePagePool({ captureWindow: () => window as never })
    const page = await pool.create(input("failed-capture"))
    captureOperation = async () => {
      expect(children.size).toBe(1)
      throw new Error("Capture refused")
    }
    try {
      await expect(page.execute({ type: "screenshot" })).rejects.toThrow("Capture refused")
      expect(children.size).toBe(0)
    } finally {
      captureOperation = undefined
      await pool.destroy()
    }
  })

  test("hands a usable detached viewport to native presentation and retains the last size on detach", async () => {
    commands.length = 0
    nativeViewports.length = 0
    const pool = new BrowserNativePagePool()
    const initial = input("initial")
    const children = new Set<MockWebContentsView>()
    const window = {
      contentView: {
        addChildView: (view: MockWebContentsView) => children.add(view),
        removeChildView: (view: MockWebContentsView) => children.delete(view),
      },
    }
    await pool.create(initial)

    expect(currentBounds).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
    expect(nativeViewports).toEqual([{ width: 1280, height: 720 }])
    expect(commands).toEqual([{ type: "navigate", url: "https://example.com", source: "user" }])
    const view = pool.attach(window as never, initial.ownerKey, initial.page.id)
    expect(nativeViewports.at(-1)).toBeNull()
    view.setBounds({ x: 320, y: 50, width: 800, height: 600 })
    pool.detach(window as never, initial.ownerKey, initial.page.id)
    expect(nativeViewports.at(-1)).toEqual({ width: 800, height: 600 })
    expect(children.size).toBe(0)
    expect(currentBounds).toEqual({ x: 320, y: 50, width: 800, height: 600 })
    await pool.destroy()
  })

  test("cleans up a failed popup without closing or replacing its opener", async () => {
    const events: Array<{ type: string; pageId: string; message?: string }> = []
    const popups: BrowserNativePageHandle[] = []
    const pool = new BrowserNativePagePool()
    const parentInput = input("popup-failure", (event) => events.push(event))
    const parent = await pool.create({ ...parentInput, onPopup: (_input, handle) => popups.push(handle) })
    const parentView = views.at(-1)!
    const response = openPopup!({ url: "https://signin.example/login" } as Electron.HandlerDetails)
    expect(response.action).toBe("allow")
    nextDiagnosticsError = new Error("fixture diagnostics failed")
    const child = response.createWindow!({})
    try {
      await until(() => events.some((event) => event.message === "Popup could not open: fixture diagnostics failed"))
      expect(child.isDestroyed()).toBe(true)
      expect(popups).toEqual([])
      expect(parentView.webContents.isDestroyed()).toBe(false)
      expect(pool.find(parentInput.ownerKey, parentInput.page.id)).toBe(parent)
      expect(parent.isAlive()).toBe(true)
      await expect(parent.execute({ type: "reload" })).resolves.toEqual({ type: "void" })
      expect(events.at(-1)?.pageId).toBe(parentInput.page.id)
    } finally {
      nextDiagnosticsError = null
      await pool.destroy()
    }
  })

  test("publishes background document-title changes without replacing the page", async () => {
    const events: Array<{ type: string; page?: { id: string; title: string } }> = []
    const pool = new BrowserNativePagePool()
    const handle = await pool.create(input("title-change", (event) => events.push(event)))
    const contents = views.at(-1)!.webContents
    contents.title = "Background title"
    contents.emit("page-title-updated", {}, contents.title)
    expect(events.at(-1)).toMatchObject({
      type: "page.updated",
      page: { id: handle.state().id, title: "Background title" },
    })
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

  test("rate-limits resume-driven recovery while the native Retry control is not limited", async () => {
    views.length = 0
    viewCreationAttempts = 0
    const events: any[] = []
    const pool = new BrowserNativePagePool({ recoveryDelaysMs: [0, 0, 0], resumeRecoveryCooldownMs: 60_000 })
    const handle = await pool.create(input("resume-cooldown", (event) => events.push(event)))
    failNewViews = true
    views.at(-1)!.webContents.emit("render-process-gone")
    await until(() => events.some((event) => event.type === "host.status" && event.status === "failed"))

    // The first resume after a failure starts one recovery flight (no cooldown
    // recorded yet); view creation still fails, so the page stays failed.
    const attemptsBeforeFirstResume = viewCreationAttempts
    await expect(handle.execute({ type: "resume" })).rejects.toMatchObject({
      code: "browser_native_recovery_failed",
    })
    expect(viewCreationAttempts).toBeGreaterThan(attemptsBeforeFirstResume)

    // An immediate second resume is rate-limited: no new recovery flight starts.
    const attemptsBeforeCooldown = viewCreationAttempts
    const restartingCount = events.filter(
      (event) => event.type === "host.status" && event.status === "restarting",
    ).length
    await expect(handle.execute({ type: "resume" })).rejects.toMatchObject({
      code: "browser_native_recovery_failed",
    })
    expect(viewCreationAttempts).toBe(attemptsBeforeCooldown)
    expect(events.filter((event) => event.type === "host.status" && event.status === "restarting")).toHaveLength(
      restartingCount,
    )

    // The native Retry control is a deliberate human action: it bypasses the cooldown.
    failNewViews = false
    await pool.retry("resume-cooldown", "page-resume-cooldown")
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
