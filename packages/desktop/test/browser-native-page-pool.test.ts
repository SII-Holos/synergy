import { describe, expect, mock, test } from "bun:test"

const lifecycle: string[] = []
const bounds: Array<{ x: number; y: number; width: number; height: number }> = []
let currentBounds = { x: 0, y: 0, width: 0, height: 0 }
let resizePage: ((width: number, height: number) => void) | undefined

class MockWebContents {
  readonly session = { setProxy: async () => undefined }

  async loadURL() {
    lifecycle.push("load")
  }

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
    lifecycle.push("bounds")
    bounds.push(value)
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

    async execute() {
      return { type: "void" }
    }

    async dispose() {}
  },
}))

const { BrowserNativePagePool } = await import("../src/browser-native-page-pool.js")

describe("Browser native page pool", () => {
  test("sets a usable viewport before loading the native page", async () => {
    lifecycle.length = 0
    bounds.length = 0
    const pool = new BrowserNativePagePool()

    await pool.create({
      ownerKey: "scope:test:session:test",
      page: { id: "page-test", url: "about:blank", title: "", isLoading: false, lastActiveAt: null },
      networkProxy: { server: "http://127.0.0.1:1234", username: "user", password: "password" },
      downloadDir: "/tmp",
      emit() {},
    })

    expect(lifecycle.slice(0, 2)).toEqual(["bounds", "load"])
    expect(bounds[0]?.width).toBeGreaterThanOrEqual(1)
    expect(bounds[0]?.height).toBeGreaterThanOrEqual(1)
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
