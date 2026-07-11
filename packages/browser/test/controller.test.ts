import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import {
  BrowserProtocolError,
  CdpPageController,
  browserOwnerKey,
  cdpCommandTimeoutMs,
  type CdpTransport,
} from "../src"

class FakeTransport implements CdpTransport {
  readonly calls: { method: string; params?: Record<string, unknown> }[] = []
  private listeners = new Map<string, Set<(params: unknown) => void>>()

  constructor(private evaluate?: (expression: string) => unknown) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params })
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "")
      if (expression.includes("candidates: matches.slice")) {
        return { result: { value: { count: 1, candidates: [{ tag: "button", name: "Continue with Holos" }] } } } as T
      }
      if (expression.includes("__synergyBrowserResolve") && expression.includes(")[0]")) {
        return { result: { objectId: "button-object" } } as T
      }
      if (expression.includes("document.title")) {
        return { result: { value: { url: "https://example.com/", title: "Example" } } } as T
      }
      if (this.evaluate) return { result: { value: this.evaluate(expression) } } as T
      return { result: { value: null } } as T
    }
    if (method === "Runtime.callFunctionOn") {
      return {
        result: {
          value: {
            visible: true,
            enabled: true,
            editable: true,
            stable: true,
            receivesEvents: true,
            box: { x: 10, y: 20, width: 100, height: 30 },
          },
        },
      } as T
    }
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            nodeId: "ax-1",
            backendDOMNodeId: 42,
            role: { value: "button" },
            name: { value: "Continue with Holos" },
          },
        ],
      } as T
    }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } } as T
    if (method === "Page.createIsolatedWorld") return { executionContextId: 99 } as T
    return {} as T
  }

  on(event: string, listener: (params: unknown) => void) {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    return () => listeners.delete(listener)
  }

  emit(event: string, params: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(params)
  }
}

describe("CdpPageController", () => {
  test("honors explicit evaluation timeouts without extending ordinary CDP hangs", () => {
    expect(cdpCommandTimeoutMs("Runtime.evaluate", { timeout: 120_000 })).toBe(123_000)
    expect(cdpCommandTimeoutMs("Runtime.evaluate", { timeout: 1_000 })).toBe(10_000)
    expect(cdpCommandTimeoutMs("Page.navigate")).toBe(10_000)
  })
  test("owner keys remain deterministic for malformed UTF-16 input", () => {
    expect(browserOwnerKey({ mode: "session", scopeID: "scope\ud800", sessionID: "session\udfff" })).toBe(
      "scope:scope%EF%BF%BD:session:session%EF%BF%BD",
    )
  })

  test("readonly evaluation fails closed with throwOnSideEffect", async () => {
    const transport = new FakeTransport()
    const controller = new CdpPageController({ pageId: "page-1", transport })

    await controller.execute({ type: "evaluate", mode: "readonly", expression: "document.title" })

    expect(transport.calls.at(-1)).toMatchObject({
      method: "Runtime.evaluate",
      params: { throwOnSideEffect: true, returnByValue: true, awaitPromise: true },
    })
  })

  test("snapshot refs are generation-bound and stale after navigation", async () => {
    const transport = new FakeTransport()
    const controller = new CdpPageController({ pageId: "page-1", transport })
    const snapshot = await controller.execute({ type: "snapshot", maxNodes: 50 })
    expect(snapshot.type).toBe("snapshot")
    if (snapshot.type !== "snapshot") throw new Error("missing snapshot")
    expect(snapshot.elements[0]?.ref).toMatch(/^@/)

    transport.emit("Page.frameNavigated", { frame: { id: "frame-2" } })

    await expect(controller.resolveRef(snapshot.snapshotId, snapshot.elements[0]!.ref)).rejects.toMatchObject({
      code: "browser_stale_ref",
    })
  })

  test("returns structured protocol errors", () => {
    const error = new BrowserProtocolError({
      code: "browser_obstructed",
      message: "Target is covered",
      retryable: true,
      pageId: "page-1",
      obstruction: { tag: "div", role: "dialog" },
      suggestedAction: "Close the dialog and take a new snapshot.",
    })
    expect(error.toJSON()).toEqual({
      type: "error",
      code: "browser_obstructed",
      message: "Target is covered",
      retryable: true,
      pageId: "page-1",
      obstruction: { tag: "div", role: "dialog" },
      suggestedAction: "Close the dialog and take a new snapshot.",
    })
  })

  test("captures a checkpoint when document storage access is denied", async () => {
    const sandbox = {
      location: { href: "https://example.com/", origin: "https://example.com" },
      document: { querySelectorAll: () => [] },
      innerWidth: 1024,
      innerHeight: 768,
      scrollX: 0,
      scrollY: 0,
    }
    Object.defineProperties(sandbox, {
      localStorage: { get: () => assertStorageDenied() },
      sessionStorage: { get: () => assertStorageDenied() },
    })
    const transport = new FakeTransport((expression) => runInNewContext(expression, sandbox))
    const controller = new CdpPageController({ pageId: "page-1", transport })

    const result = await controller.execute({ type: "checkpoint", action: "capture" })

    expect(result).toMatchObject({
      type: "data",
      data: {
        url: "https://example.com/",
        origins: [
          {
            origin: "https://example.com",
            localStorage: {},
            sessionStorage: {},
          },
        ],
        viewport: { width: 1024, height: 768 },
      },
    })
  })

  test("rejects Playwright-only CSS before attempting input", async () => {
    const transport = new FakeTransport()
    const controller = new CdpPageController({ pageId: "page-1", transport })

    await expect(
      controller.execute({
        type: "action",
        action: {
          type: "click",
          target: { kind: "css", value: 'button:has-text("Continue with Holos")' },
        },
      }),
    ).rejects.toMatchObject({
      code: "browser_invalid_selector",
      retryable: false,
    })
    expect(transport.calls.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false)
  })

  test("clicks a unique role locator through shared CDP input", async () => {
    const transport = new FakeTransport()
    const controller = new CdpPageController({ pageId: "page-1", transport })
    const result = await controller.execute({
      type: "action",
      action: {
        type: "click",
        target: { kind: "role", role: "button", name: "Continue with Holos" },
      },
    })

    expect(result).toMatchObject({ type: "action", action: "click" })
    expect(transport.calls.filter((call) => call.method === "Input.dispatchMouseEvent")).toHaveLength(2)
  })

  test("applies mobile and touch emulation without requiring a viewport override", async () => {
    const transport = new FakeTransport()
    const controller = new CdpPageController({ pageId: "page-1", transport })

    await controller.execute({ type: "emulate", emulation: { mobile: true, touch: true } })

    expect(transport.calls).toContainEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        mobile: true,
        screenWidth: 1280,
        screenHeight: 720,
      },
    })
    expect(transport.calls).toContainEqual({
      method: "Emulation.setTouchEmulationEnabled",
      params: { enabled: true, maxTouchPoints: 5 },
    })
  })
})

function assertStorageDenied(): never {
  throw new DOMException("Storage access is denied", "SecurityError")
}
