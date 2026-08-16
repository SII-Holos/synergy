import { describe, expect, test } from "bun:test"
import { electronMockState, registerElectronMock } from "./electron-mock"

interface MockViewOptions {
  webPreferences?: { preload?: string; contextIsolation?: boolean; nodeIntegration?: boolean; sandbox?: boolean }
}

interface MockViewContents {
  destroyed: boolean
  loadURL(url: string): Promise<void>
  setWindowOpenHandler(handler: unknown): void
  executeJavaScript(code: string): Promise<unknown>
  isDestroyed(): boolean
  close(): void
}

const views: MockWebContentsView[] = []
const loadedUrls: string[] = []
const executedScripts: string[] = []
let loadFailure: Error | null = null

class MockWebContentsView {
  readonly options: MockViewOptions
  readonly webContents: MockViewContents

  constructor(options: MockViewOptions) {
    this.options = options
    const contents: MockViewContents = {
      destroyed: false,
      async loadURL(url: string) {
        if (loadFailure) throw loadFailure
        loadedUrls.push(url)
      },
      setWindowOpenHandler() {},
      async executeJavaScript(code: string) {
        executedScripts.push(code)
        return undefined
      },
      isDestroyed() {
        return contents.destroyed
      },
      close() {
        contents.destroyed = true
      },
    }
    this.webContents = contents
    views.push(this)
  }

  setBounds(_bounds: unknown) {}
}

registerElectronMock()
electronMockState.viewBuilder = (options) => new MockWebContentsView(options as MockViewOptions)

const { DesktopStartupOverlay } = await import("../src/startup-overlay.js")
const { desktopThemeSnapshot, defaultDesktopSkinState } = await import("../src/theme.js")

function theme(mode: "light" | "dark") {
  return desktopThemeSnapshot(defaultDesktopSkinState(mode), mode === "dark")
}

function windowFixture() {
  const listeners = new Map<string, Array<() => void>>()
  const contentView = {
    children: [] as MockWebContentsView[],
    added: [] as MockWebContentsView[],
    removed: [] as MockWebContentsView[],
    addChildView(view: MockWebContentsView) {
      this.children.push(view)
      this.added.push(view)
    },
    removeChildView(view: MockWebContentsView) {
      this.children = this.children.filter((child) => child !== view)
      this.removed.push(view)
    },
  }
  const window = {
    destroyed: false,
    contentView,
    bounds: { width: 1000, height: 700 },
    on(event: string, listener: () => void) {
      const current = listeners.get(event) ?? []
      current.push(listener)
      listeners.set(event, current)
    },
    off(event: string, listener: () => void) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((item) => item !== listener),
      )
    },
    isDestroyed() {
      return this.destroyed
    },
    getContentBounds() {
      return this.bounds
    },
    emit(event: string) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener()
    },
  }
  return window
}

describe("desktop startup overlay", () => {
  test("creates an isolated sandboxed overlay view with the preload script", () => {
    views.length = 0
    const window = windowFixture()
    new DesktopStartupOverlay({
      window: window as never,
      preloadPath: "/dist/preload.cjs",
      chrome: "custom",
      theme: theme("light"),
    })

    expect(views).toHaveLength(1)
    expect(views[0]!.options).toEqual({
      webPreferences: {
        preload: "/dist/preload.cjs",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
  })

  test("loads the themed startup page and attaches to the window content view", async () => {
    views.length = 0
    loadedUrls.length = 0
    const window = windowFixture()
    const overlay = new DesktopStartupOverlay({
      window: window as never,
      preloadPath: "/dist/preload.cjs",
      chrome: "custom",
      iconDataUrl: "data:image/png;base64,c3luZXJneQ==",
      theme: theme("dark"),
    })

    await overlay.load()
    expect(loadedUrls).toHaveLength(1)
    expect(loadedUrls[0]).toContain("data:text/html")
    expect(decodeURIComponent(loadedUrls[0]!.slice(loadedUrls[0]!.indexOf(",") + 1))).toContain("c3luZXJneQ==")

    overlay.attach()
    expect(window.contentView.children).toHaveLength(1)

    window.bounds = { width: 800, height: 600 }
    window.emit("resize")
    await overlay.dismiss()
  })

  test("ignores load and attach after dismissal or window destruction", async () => {
    views.length = 0
    loadedUrls.length = 0
    executedScripts.length = 0
    const window = windowFixture()
    const overlay = new DesktopStartupOverlay({
      window: window as never,
      preloadPath: "/dist/preload.cjs",
      chrome: "custom",
      theme: theme("light"),
    })

    await overlay.dismiss()
    expect(views[0]!.webContents.destroyed).toBe(true)

    await overlay.load()
    overlay.attach()
    expect(loadedUrls).toEqual([])
    expect(window.contentView.children).toEqual([])

    const destroyedWindow = windowFixture()
    destroyedWindow.destroyed = true
    const destroyedOverlay = new DesktopStartupOverlay({
      window: destroyedWindow as never,
      preloadPath: "/dist/preload.cjs",
      chrome: "custom",
      theme: theme("light"),
    })
    await destroyedOverlay.load()
    destroyedOverlay.attach()
    expect(destroyedWindow.contentView.children).toEqual([])
    await destroyedOverlay.dismiss()
    await destroyedOverlay.setStatus({ title: "Loading", detail: "" })
    destroyedOverlay.setTheme(theme("dark"))
    expect(executedScripts).toEqual([])
  })

  test("serializes status and theme updates through the overlay page", async () => {
    views.length = 0
    executedScripts.length = 0
    const window = windowFixture()
    const overlay = new DesktopStartupOverlay({
      window: window as never,
      preloadPath: "/dist/preload.cjs",
      chrome: "custom",
      theme: theme("light"),
    })

    await overlay.load()
    await overlay.setStatus({ title: "Loading workspace", detail: "Connecting" })
    overlay.setTheme(theme("dark"))
    await Bun.sleep(0)

    expect(executedScripts).toHaveLength(2)
    expect(executedScripts[0]).toContain("Loading workspace")
    expect(executedScripts[1]).toContain('"effective":"dark"')
  })

  test("tolerates load failures and detached views on dismiss", async () => {
    views.length = 0
    loadedUrls.length = 0
    loadFailure = new Error("renderer unavailable")
    try {
      const window = windowFixture()
      const overlay = new DesktopStartupOverlay({
        window: window as never,
        preloadPath: "/dist/preload.cjs",
        chrome: "custom",
        theme: theme("light"),
      })

      await expect(overlay.load()).rejects.toThrow("renderer unavailable")
      await overlay.dismiss()
    } finally {
      loadFailure = null
    }

    views.length = 0
    const window = windowFixture()
    const overlay = new DesktopStartupOverlay({
      window: window as never,
      preloadPath: "/dist/preload.cjs",
      chrome: "custom",
      theme: theme("light"),
    })
    overlay.attach()
    views[0]!.webContents.destroyed = true
    await overlay.dismiss()
    expect(window.contentView.children).toEqual([])
  })
})
