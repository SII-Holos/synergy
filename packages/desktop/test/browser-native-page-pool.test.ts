import { describe, expect, mock, test } from "bun:test"

const commands: unknown[] = []
let currentBounds = { x: 0, y: 0, width: 0, height: 0 }
let resizePage: ((width: number, height: number) => void) | undefined

class MockWebContents {
  readonly session = { setProxy: async () => undefined }

  async loadURL() {}

  getURL() {
    return "about:blank"
  }

  getTitle() {
    return ""
  }

  isLoading() {
    return false
  }

  isDestroyed() {
    return false
  }

  close() {}
  on() {}
}

class MockWebContentsView {
  readonly webContents = new MockWebContents()

  setBounds(value: { x: number; y: number; width: number; height: number }) {
    currentBounds = value
  }

  getBounds() {
    return currentBounds
  }
}

mock.module("electron", () => ({
  app: { on() {}, off() {} },
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
      commands.push(command)
      return { type: "void" }
    }

    async dispose() {}
  },
}))

const { BrowserNativePagePool } = await import("../src/browser-native-page-pool.js")

describe("Browser native page pool", () => {
  test("sets a usable CSS viewport before the first navigation", async () => {
    commands.length = 0
    const pool = new BrowserNativePagePool()

    await pool.create({
      ownerKey: "scope:test:session:test",
      page: { id: "page-test", url: "https://example.com", title: "", isLoading: false, lastActiveAt: null },
      networkProxy: { server: "http://127.0.0.1:1234", username: "user", password: "password" },
      downloadDir: "/tmp",
      emit() {},
    })

    expect(commands.slice(0, 2)).toEqual([
      { type: "setViewport", width: 1280, height: 720 },
      { type: "navigate", url: "https://example.com", source: "user" },
    ])
  })

  test("viewport changes preserve the attached native view position", async () => {
    const pool = new BrowserNativePagePool()

    await pool.create({
      ownerKey: "scope:test:session:resize",
      page: { id: "page-resize", url: "about:blank", title: "", isLoading: false, lastActiveAt: null },
      networkProxy: { server: "http://127.0.0.1:1234", username: "user", password: "password" },
      downloadDir: "/tmp",
      emit() {},
    })

    currentBounds = { x: 640, y: 96, width: 800, height: 600 }
    resizePage?.(1024, 768)

    expect(currentBounds).toEqual({ x: 640, y: 96, width: 1024, height: 768 })
  })
})
