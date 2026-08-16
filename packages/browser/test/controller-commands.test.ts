import { describe, expect, test } from "bun:test"
import { BrowserProtocolError, CdpPageController, withCdpCommandTimeout, type CdpTransport } from "../src"

type SendHandler = (params?: Record<string, unknown>) => unknown

class FakeTransport implements CdpTransport {
  readonly calls: { method: string; params?: Record<string, unknown> }[] = []
  private listeners = new Map<string, Set<(params: unknown) => void>>()
  private responses = new Map<string, unknown | SendHandler>()
  private callFunctionHandler: SendHandler | undefined
  locatorCount = 1

  respond(method: string, response: SendHandler): void
  respond(method: string, response: unknown): void
  respond(method: string, response: unknown | SendHandler) {
    this.responses.set(method, response)
  }

  setCallFunction(handler: SendHandler) {
    this.callFunctionHandler = handler
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params })
    const response = this.responses.get(method)
    if (response !== undefined) {
      return (typeof response === "function" ? response(params) : response) as T
    }
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "")
      if (expression.includes("count: matches.length")) {
        return { result: { value: { count: this.locatorCount, candidates: [] } } } as T
      }
      if (expression.includes("candidates: matches.slice")) {
        return { result: { value: { count: this.locatorCount, candidates: [] } } } as T
      }
      if (expression.includes(")[0]")) {
        return { result: { objectId: "object-1" } } as T
      }
      return { result: { value: null } } as T
    }
    if (method === "Runtime.callFunctionOn") {
      const value = this.callFunctionHandler?.(params) ?? {
        visible: true,
        enabled: true,
        editable: true,
        receivesEvents: true,
        box: { x: 10, y: 20, width: 100, height: 30 },
      }
      return { result: { value } } as T
    }
    if (method === "Accessibility.getFullAXTree") {
      return { nodes: [] } as T
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main-frame" } } } as T
    }
    return {} as T
  }

  on(event: string, listener: (params: unknown) => void) {
    const set = this.listeners.get(event) ?? new Set<(params: unknown) => void>()
    set.add(listener)
    this.listeners.set(event, set)
    return () => set.delete(listener)
  }

  emit(event: string, params: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(params)
  }
}

const controllerFor = (
  transport: FakeTransport,
  options: Partial<ConstructorParameters<typeof CdpPageController>[0]> = {},
) => new CdpPageController({ pageId: "page-1", transport, ...options })

describe("withCdpCommandTimeout", () => {
  test("resolves with the command value and clears the timer", async () => {
    const value = await withCdpCommandTimeout(Promise.resolve("done"), "TestCommand", 10_000)
    expect(value).toBe("done")
  })

  test("rejects with a timeout error when the command hangs", async () => {
    await expect(withCdpCommandTimeout(new Promise(() => {}), "TestCommand", 10)).rejects.toThrow(
      "CDP command TestCommand timed out after 0.01 seconds.",
    )
  })

  test("propagates command failures", async () => {
    await expect(
      withCdpCommandTimeout(Promise.reject(new Error("backend down")), "TestCommand", 10_000),
    ).rejects.toThrow("backend down")
  })
})

describe("CdpPageController navigation and lifecycle commands", () => {
  test("reports navigation failures as structured protocol errors", async () => {
    const transport = new FakeTransport()
    transport.respond("Page.navigate", { errorText: "net::ERR_NAME_NOT_RESOLVED" })
    const controller = controllerFor(transport)

    await expect(
      controller.execute({ type: "navigate", url: "https://example.com/", source: "agent", settleMode: "none" }),
    ).rejects.toMatchObject({
      code: "browser_navigation_failed",
      url: "https://example.com/",
      retryable: true,
    })
  })

  test("navigates history and rejects when no entry exists", async () => {
    const transport = new FakeTransport()
    transport.respond("Page.getNavigationHistory", {
      currentIndex: 1,
      entries: [{ id: 0 }, { id: 1 }, { id: 2 }],
    })
    const controller = controllerFor(transport)

    const result = await controller.execute({ type: "history", direction: "back", settleMode: "none" })
    expect(result).toMatchObject({ type: "navigation", settled: true, settleReason: "none" })
    expect(
      transport.calls.some((call) => call.method === "Page.navigateToHistoryEntry" && call.params?.entryId === 0),
    ).toBe(true)

    transport.respond("Page.getNavigationHistory", { currentIndex: 0, entries: [{ id: 0 }] })
    await expect(
      controller.execute({ type: "history", direction: "forward", settleMode: "none" }),
    ).rejects.toMatchObject({
      code: "browser_history_unavailable",
    })
  })

  test("rejects file chooser selection before any backend interaction", async () => {
    const transport = new FakeTransport()
    const controller = controllerFor(transport)

    await expect(
      controller.execute({ type: "filechooser.select", requestId: "chooser-1", files: [] }),
    ).rejects.toMatchObject({ code: "browser_upload_staging_required" })
    expect(transport.calls.some((call) => call.method === "DOM.setFileInputFiles")).toBe(false)
  })

  test("falls back to a stable page state when the renderer context is gone", async () => {
    const transport = new FakeTransport()
    transport.respond("Runtime.evaluate", (params) => {
      const expression = String(params?.expression ?? "")
      if (expression.includes("globalThis.location?.href")) throw new Error("context destroyed")
      return { result: { value: null } }
    })
    const controller = controllerFor(transport)

    const result = await controller.execute({
      type: "navigate",
      url: "https://example.com/",
      source: "agent",
      settleMode: "none",
    })
    expect(result).toMatchObject({
      type: "navigation",
      page: { id: "page-1", url: "", title: "" },
    })
  })
})

describe("CdpPageController dialog, clipboard, and upload", () => {
  test("tracks, accepts, and dismisses dialogs and errors on missing dialogs", async () => {
    const transport = new FakeTransport()
    const controller = controllerFor(transport)
    transport.emit("Page.javascriptDialogOpening", {
      type: "prompt",
      message: "Please confirm",
      defaultPrompt: "default",
      url: "https://example.com/prompt?token=secret",
    })

    const status = await controller.execute({ type: "dialog", action: "status" })
    expect(status).toMatchObject({ type: "data", data: { open: true } })

    const handled = await controller.execute({ type: "dialog", action: "accept", promptText: "yes" })
    expect(handled).toMatchObject({ type: "data", data: { open: false, handled: "accept" } })
    expect(
      transport.calls.some(
        (call) =>
          call.method === "Page.handleJavaScriptDialog" &&
          call.params?.accept === true &&
          call.params?.promptText === "yes",
      ),
    ).toBe(true)

    await expect(controller.execute({ type: "dialog", action: "dismiss" })).rejects.toMatchObject({
      code: "browser_dialog_missing",
    })
  })

  test("reads, writes, and clears clipboard content with limits", async () => {
    let written = ""
    const transport = new FakeTransport()
    const controller = controllerFor(transport, {
      clipboard: {
        readText: () => "copied text",
        writeText: (text) => {
          written = text
        },
      },
    })

    expect(await controller.execute({ type: "clipboard", action: "read" })).toMatchObject({
      type: "data",
      data: { text: "copied text" },
    })
    expect(await controller.execute({ type: "clipboard", action: "write", text: "hello" })).toMatchObject({
      type: "data",
      data: { written: true, byteLength: 5 },
    })
    expect(written).toBe("hello")
    expect(await controller.execute({ type: "clipboard", action: "clear" })).toMatchObject({
      type: "data",
      data: { written: true, byteLength: 0 },
    })
    expect(written).toBe("")

    await expect(controller.execute({ type: "clipboard", action: "write" })).rejects.toThrow(
      "text is required for write",
    )

    const large = controllerFor(transport, {
      clipboard: { readText: () => "x".repeat(1024 * 1024 + 1), writeText: () => {} },
    })
    await expect(large.execute({ type: "clipboard", action: "read" })).rejects.toMatchObject({
      code: "browser_clipboard_too_large",
    })

    const noAdapter = controllerFor(new FakeTransport())
    await expect(noAdapter.execute({ type: "clipboard", action: "read" })).rejects.toMatchObject({
      code: "browser_clipboard_unavailable",
    })
  })

  test("stages upload files and cleans up when injection fails", async () => {
    const transport = new FakeTransport()
    transport.respond("DOM.describeNode", { node: { backendNodeId: 7 } })
    let cleanedUp = false
    const staged: string[] = []
    const controller = controllerFor(transport, {
      stageFiles: async (files) => {
        staged.push(...files.map((file) => file.name))
        return {
          paths: ["/tmp/staged-a.txt"],
          cleanup: async () => {
            cleanedUp = true
          },
        }
      },
    })

    const result = await controller.execute({
      type: "upload",
      target: { kind: "css", value: "input[type=file]" },
      files: [{ name: "a.txt", mimeType: "text/plain", dataBase64: "aGVsbG8=" }],
    })
    expect(result).toMatchObject({ type: "data", data: { uploaded: [{ name: "a.txt", mimeType: "text/plain" }] } })
    expect(staged).toEqual(["a.txt"])
    expect(
      transport.calls.some((call) => call.method === "DOM.setFileInputFiles" && call.params?.backendNodeId === 7),
    ).toBe(true)

    transport.respond("DOM.setFileInputFiles", () => {
      throw new Error("injection failed")
    })
    await expect(
      controller.execute({
        type: "upload",
        target: { kind: "css", value: "input[type=file]" },
        files: [{ name: "b.txt", mimeType: "text/plain", dataBase64: "d29ybGQ=" }],
      }),
    ).rejects.toThrow("injection failed")
    expect(cleanedUp).toBe(true)
  })

  test("rejects uploads without a staging adapter", async () => {
    const controller = controllerFor(new FakeTransport())
    await expect(
      controller.execute({
        type: "upload",
        target: { kind: "css", value: "input[type=file]" },
        files: [{ name: "a.txt", mimeType: "text/plain", dataBase64: "aGVsbG8=" }],
      }),
    ).rejects.toMatchObject({ code: "browser_upload_unavailable" })
  })
})

describe("CdpPageController event capture", () => {
  test("records console and log entries with redaction at read time", async () => {
    const transport = new FakeTransport()
    const controller = controllerFor(transport)
    transport.emit("Runtime.consoleAPICalled", {
      type: "log",
      timestamp: 1000,
      args: [{ value: "hello" }, { value: { nested: true } }, { description: "desc-only" }],
      stackTrace: { callFrames: [{ url: "https://example.com/a.js?token=secret", functionName: "f" }] },
    })
    transport.emit("Log.entryAdded", {
      entry: {
        level: "error",
        text: "boom",
        timestamp: 2000,
        url: "https://example.com/x",
        stackTrace: "raw stack with token=abc",
      },
    })

    const list = await controller.execute({ type: "console", action: "list" })
    expect(list).toMatchObject({
      type: "data",
      data: { page: 0, total: 2, entries: [{ id: "console-1" }, { id: "console-2" }] },
    })
    const data =
      list.type === "data" ? (list.data as { entries: Array<{ id: string; text: string; stack?: unknown }> }) : null
    expect(data?.entries[0]?.text).toBe('hello {"nested":true} desc-only')
    expect(JSON.stringify(data?.entries[0]?.stack)).not.toContain("secret")
    expect(JSON.stringify(data?.entries[1]?.stack)).not.toContain("abc")

    expect(await controller.execute({ type: "console", action: "list", level: "error" })).toMatchObject({
      type: "data",
      data: { total: 1 },
    })
    expect(await controller.execute({ type: "console", action: "get", id: "console-2" })).toMatchObject({
      type: "data",
      data: { id: "console-2" },
    })
    expect(await controller.execute({ type: "console", action: "clear" })).toMatchObject({
      type: "data",
      data: { entries: [], total: 0 },
    })
  })

  test("tracks network requests with filters, bodies, and failures", async () => {
    const transport = new FakeTransport()
    const controller = controllerFor(transport)
    transport.emit("Network.requestWillBeSent", {
      requestId: "r-1",
      type: "XHR",
      timestamp: 1000,
      request: {
        url: "https://example.com/api?token=secret",
        method: "POST",
        headers: { Authorization: "Bearer abc" },
        postData: "password=hunter2",
      },
    })
    transport.emit("Network.responseReceived", {
      requestId: "r-1",
      type: "XHR",
      response: {
        status: 200,
        statusText: "OK",
        headers: { "Set-Cookie": "session=1" },
        mimeType: "application/json",
        protocol: "h2",
        remoteIPAddress: "1.2.3.4",
        fromDiskCache: false,
        timing: { t: 1 },
      },
    })
    transport.emit("Network.requestWillBeSent", { requestId: "r-2" })
    transport.emit("Network.loadingFailed", { requestId: "r-2", errorText: "net::ERR_FAILED" })
    transport.emit("Network.requestWillBeSent", { requestId: "r-3", type: "WebSocket" })
    transport.emit("Network.loadingFinished", { requestId: "r-3" })

    const list = await controller.execute({ type: "network", action: "list" })
    expect(list).toMatchObject({ type: "data", data: { total: 3 } })
    const listed = list.type === "data" ? (list.data as { requests: Array<Record<string, unknown>> }) : null
    expect(JSON.stringify(listed?.requests[0])).not.toContain("secret")
    expect(JSON.stringify(listed?.requests[0])).not.toContain("Bearer abc")
    expect(listed?.requests[1]?.failed).toBe("net::ERR_FAILED")

    const sensitive = await controller.execute({ type: "network", action: "list", includeSensitive: true })
    const sensitiveData =
      sensitive.type === "data" ? (sensitive.data as { requests: Array<Record<string, unknown>> }) : null
    expect(JSON.stringify(sensitiveData?.requests[0]?.requestHeaders)).toContain("Bearer abc")

    expect(
      await controller.execute({ type: "network", action: "list", resourceTypes: ["XHR"], status: 200 }),
    ).toMatchObject({ type: "data", data: { total: 1 } })
    expect(await controller.execute({ type: "network", action: "list", status: 404 })).toMatchObject({
      type: "data",
      data: { total: 0 },
    })

    transport.respond("Network.getResponseBody", { body: "hello world", base64Encoded: false })
    const body = await controller.execute({ type: "network", action: "get", id: "r-1", includeBody: true })
    expect(body).toMatchObject({ type: "data", data: { body: "hello world", base64Encoded: false } })

    transport.respond("Network.getResponseBody", { body: "aGVsbG8gd29ybGQ=", base64Encoded: true })
    const truncated = await controller.execute({
      type: "network",
      action: "get",
      id: "r-1",
      includeBody: true,
      maxBodyBytes: 4,
    })
    expect(truncated).toMatchObject({
      type: "data",
      data: { body: "aGVs", base64Encoded: true, bodyTruncated: true },
    })

    expect(await controller.execute({ type: "network", action: "get", id: "missing" })).toMatchObject({
      type: "data",
      data: null,
    })
    expect(await controller.execute({ type: "network", action: "clear" })).toMatchObject({
      type: "data",
      data: { requests: [], total: 0 },
    })
  })

  test("starts, collects, and stops performance traces", async () => {
    const transport = new FakeTransport()
    const controller = controllerFor(transport)

    await expect(controller.execute({ type: "performance", action: "stopTrace" })).rejects.toMatchObject({
      code: "browser_trace_not_running",
    })

    expect(await controller.execute({ type: "performance", action: "startTrace" })).toMatchObject({
      type: "data",
      data: { tracing: true },
    })
    await expect(controller.execute({ type: "performance", action: "startTrace" })).rejects.toMatchObject({
      code: "browser_trace_already_running",
    })

    transport.emit("Tracing.dataCollected", {
      value: [
        { name: "RunTask", dur: 50000 },
        { name: "Task", dur: 100000 },
      ],
    })
    const stopped = controller.execute({ type: "performance", action: "stopTrace" })
    setTimeout(() => transport.emit("Tracing.tracingComplete", {}), 0)
    const result = await stopped
    expect(result).toMatchObject({
      type: "data",
      data: {
        tracing: false,
        traceTruncated: false,
        summary: { eventCount: 2, longTaskCount: 2, longTaskDurationMs: 150 },
      },
    })
  })

  test("measures runtime performance metrics", async () => {
    const transport = new FakeTransport()
    transport.respond("Performance.getMetrics", {
      metrics: [{ name: "TaskDuration", value: 1.5 }],
    })
    const controller = controllerFor(transport)

    const result = await controller.execute({ type: "performance", action: "measure" })
    expect(result).toMatchObject({
      type: "data",
      data: { metrics: { TaskDuration: 1.5 }, webVitals: {}, resources: [] },
    })
  })

  test("runs page audits against the live document", async () => {
    const transport = new FakeTransport()
    const controller = controllerFor(transport)

    const result = await controller.execute({ type: "audit", categories: ["accessibility"] })
    expect(result).toMatchObject({ type: "data" })
    expect(
      transport.calls.some(
        (call) => call.method === "Runtime.evaluate" && String(call.params?.expression).includes("requested.has"),
      ),
    ).toBe(true)
  })

  test("applies media, locale, network, and touch emulation", async () => {
    const transport = new FakeTransport()
    const controller = controllerFor(transport)

    await controller.execute({
      type: "emulate",
      emulation: {
        viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
        touch: false,
        colorScheme: "dark",
        reducedMotion: "reduce",
        forcedColors: "active",
        locale: "en-US",
        timezone: "America/New_York",
        cpuThrottlingRate: 4,
        networkProfile: "offline",
      },
    })

    expect(transport.calls).toContainEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 800, height: 600, deviceScaleFactor: 2, mobile: false, screenWidth: 800, screenHeight: 600 },
    })
    expect(transport.calls).toContainEqual({
      method: "Emulation.setTouchEmulationEnabled",
      params: { enabled: false, maxTouchPoints: 0 },
    })
    expect(transport.calls).toContainEqual({
      method: "Emulation.setEmulatedMedia",
      params: {
        features: [
          { name: "prefers-color-scheme", value: "dark" },
          { name: "prefers-reduced-motion", value: "reduce" },
          { name: "forced-colors", value: "active" },
        ],
      },
    })
    expect(transport.calls.some((call) => call.method === "Emulation.setLocaleOverride")).toBe(true)
    expect(transport.calls.some((call) => call.method === "Emulation.setTimezoneOverride")).toBe(true)
    expect(transport.calls).toContainEqual({ method: "Emulation.setCPUThrottlingRate", params: { rate: 4 } })
    expect(transport.calls).toContainEqual({
      method: "Network.emulateNetworkConditions",
      params: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
    })
  })
})

describe("CdpPageController data commands", () => {
  test("filters snapshot results by query and computes depths", async () => {
    const transport = new FakeTransport()
    transport.respond("Accessibility.getFullAXTree", {
      nodes: [
        { nodeId: "ax-1", backendDOMNodeId: 1, role: { value: "button" }, name: { value: "Save" } },
        {
          nodeId: "ax-2",
          parentId: "ax-1",
          backendDOMNodeId: 2,
          role: { value: "StaticText" },
          name: { value: "Save" },
        },
      ],
    })
    const controller = controllerFor(transport)

    const result = await controller.execute({ type: "snapshot", query: "save", maxNodes: 50 })
    expect(result).toMatchObject({
      type: "snapshot",
      elements: [
        { role: "button", name: "Save", depth: 0 },
        { role: "StaticText", name: "Save", depth: 1 },
      ],
      truncated: false,
    })
  })

  test("reads page content in text, markdown, and html formats", async () => {
    const transport = new FakeTransport()
    transport.respond("Runtime.evaluate", (params) => {
      const expression = String(params?.expression ?? "")
      if (expression.includes("document.documentElement")) {
        return { result: { value: { content: "line one\n\n\nline two  \n", length: 23 } } }
      }
      return { result: { value: null } }
    })
    const controller = controllerFor(transport)

    expect(await controller.execute({ type: "read", format: "text" })).toMatchObject({
      type: "data",
      data: { format: "text", content: "line one\n\n\nline two  \n" },
    })
    expect(await controller.execute({ type: "read", format: "markdown" })).toMatchObject({
      type: "data",
      data: { format: "markdown", content: "line one\n\nline two\n", truncated: true },
    })
    expect(await controller.execute({ type: "read", format: "html" })).toMatchObject({
      type: "data",
      data: { format: "html" },
    })
    expect(
      transport.calls.some(
        (call) => call.method === "Runtime.evaluate" && String(call.params?.expression).includes("outerHTML"),
      ),
    ).toBe(true)
  })

  test("inspects element details, listeners, and accessibility", async () => {
    const transport = new FakeTransport()
    transport.respond("DOMDebugger.getEventListeners", {
      listeners: [
        {
          type: "click",
          useCapture: true,
          passive: false,
          once: false,
          scriptId: "s1",
          lineNumber: 1,
          columnNumber: 2,
        },
      ],
    })
    transport.respond("Accessibility.getPartialAXTree", { nodes: [{ role: { value: "button" } }] })
    const controller = controllerFor(transport)

    const result = await controller.execute({
      type: "inspect",
      target: { kind: "css", value: "button" },
      computedStyles: ["display"],
    })
    expect(result).toMatchObject({
      type: "data",
      data: {
        listeners: [
          {
            type: "click",
            useCapture: true,
            passive: false,
            once: false,
            scriptId: "s1",
            lineNumber: 1,
            columnNumber: 2,
          },
        ],
        accessibilityNode: { role: { value: "button" } },
      },
    })
  })

  test("captures screenshots with clips, full pages, and viewport fallbacks", async () => {
    const transport = new FakeTransport()
    transport.respond("Page.captureScreenshot", { data: "iVBORw0KGgo=" })
    const controller = controllerFor(transport)

    const clipped = await controller.execute({
      type: "screenshot",
      clip: { x: 5, y: 5, width: 100, height: 50 },
    })
    expect(clipped).toMatchObject({
      type: "screenshot",
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      width: 100,
      height: 50,
    })
    expect(
      transport.calls.some(
        (call) => call.method === "Page.captureScreenshot" && (call.params?.clip as { width: number })?.width === 100,
      ),
    ).toBe(true)

    transport.respond("Page.getLayoutMetrics", { cssContentSize: { width: 640, height: 480 } })
    const fullPage = await controller.execute({ type: "screenshot", fullPage: true })
    expect(fullPage).toMatchObject({ type: "screenshot", width: 640, height: 480 })

    const viewport = await controller.execute({ type: "screenshot" })
    expect(viewport).toMatchObject({ type: "screenshot", width: 0, height: 0 })
  })

  test("rejects screenshots outside dimension, data, and size limits", async () => {
    const controller = controllerFor(new FakeTransport())
    await expect(
      controller.execute({ type: "screenshot", clip: { x: 0, y: 0, width: 32_768, height: 32_768 } }),
    ).rejects.toMatchObject({ code: "browser_screenshot_dimensions_exceeded" })

    const empty = controllerFor(new FakeTransport())
    await expect(empty.execute({ type: "screenshot" })).rejects.toMatchObject({ code: "browser_screenshot_failed" })

    const large = new FakeTransport()
    large.respond("Page.captureScreenshot", { data: "A".repeat(34 * 1024 * 1024) })
    await expect(
      controllerFor(large).execute({ type: "screenshot", clip: { x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toMatchObject({ code: "browser_screenshot_too_large" })
  })
})

describe("CdpPageController checkpoints", () => {
  test("captures cookies, storage, and form state", async () => {
    const transport = new FakeTransport()
    transport.respond("Network.getAllCookies", { cookies: [{ name: "session", value: "abc" }] })
    const controller = controllerFor(transport)

    const result = await controller.execute({ type: "checkpoint", action: "capture" })
    expect(result).toMatchObject({
      type: "data",
      data: { url: "about:blank", cookies: [{ name: "session", value: "abc" }] },
    })
  })

  test("restores an about:blank checkpoint without navigation", async () => {
    const transport = new FakeTransport()
    const controller = controllerFor(transport)

    const result = await controller.execute({
      type: "checkpoint",
      action: "restore",
      checkpoint: {
        url: "about:blank",
        cookies: [],
        origins: [],
        viewport: { width: 1280, height: 720 },
        scroll: { x: 0, y: 0 },
        formState: [],
      },
    })
    expect(result).toMatchObject({ type: "data", data: { restored: true } })
    expect(transport.calls.some((call) => call.method === "Page.navigate")).toBe(false)
  })

  test("restores a checkpoint with navigation, storage, and form state", async () => {
    const transport = new FakeTransport()
    const controller = controllerFor(transport)
    transport.respond("Page.navigate", (params) => {
      setTimeout(() => transport.emit("Page.lifecycleEvent", { frameId: "main-frame", name: "load" }), 0)
      return params
    })
    transport.respond("Page.reload", (params) => {
      setTimeout(() => transport.emit("Page.lifecycleEvent", { frameId: "main-frame", name: "load" }), 0)
      return params
    })

    const result = await controller.execute({
      type: "checkpoint",
      action: "restore",
      checkpoint: {
        url: "https://example.com/",
        cookies: [],
        origins: [{ origin: "https://example.com", localStorage: { theme: "dark" }, sessionStorage: {} }],
        viewport: { width: 1280, height: 720 },
        scroll: { x: 0, y: 0 },
        formState: [{ selector: "#name", value: "Ada" }],
      },
    })
    expect(result).toMatchObject({ type: "data", data: { restored: true } })
    expect(
      transport.calls.some((call) => call.method === "Page.navigate" && call.params?.url === "https://example.com/"),
    ).toBe(true)
    expect(transport.calls.some((call) => call.method === "Page.reload")).toBe(true)
  })

  test("rejects checkpoint restores whose navigation fails", async () => {
    const transport = new FakeTransport()
    transport.respond("Page.navigate", { errorText: "net::ERR_ABORTED" })
    const controller = controllerFor(transport)

    await expect(
      controller.execute({
        type: "checkpoint",
        action: "restore",
        checkpoint: {
          url: "https://example.com/",
          viewport: { width: 1280, height: 720 },
          scroll: { x: 0, y: 0 },
        },
      }),
    ).rejects.toMatchObject({ code: "browser_checkpoint_navigation_failed" })
  })
})

describe("CdpPageController wait conditions", () => {
  test("matches url, title, and text conditions", async () => {
    const transport = new FakeTransport()
    transport.respond("Runtime.evaluate", (params) => {
      const expression = String(params?.expression ?? "")
      if (expression.includes("document.body?.innerText")) return { result: { value: true } }
      if (expression.includes("globalThis.location?.href")) {
        return { result: { value: { url: "about:blank", title: "Example" } } }
      }
      return { result: { value: null } }
    })
    const controller = controllerFor(transport)

    expect(
      await controller.execute({
        type: "wait",
        condition: { type: "url", value: "about:blank", match: "equals" },
        timeoutMs: 1_000,
      }),
    ).toMatchObject({ type: "wait", matched: true })
    expect(
      await controller.execute({
        type: "wait",
        condition: { type: "title", value: "Example", match: "contains" },
        timeoutMs: 1_000,
      }),
    ).toMatchObject({ type: "wait", matched: true })
    expect(
      await controller.execute({
        type: "wait",
        condition: { type: "text", values: ["hello"], match: "any" },
        timeoutMs: 1_000,
      }),
    ).toMatchObject({ type: "wait", matched: true })
  })

  test("times out with a structured wait error", async () => {
    const controller = controllerFor(new FakeTransport())
    await expect(
      controller.execute({
        type: "wait",
        condition: { type: "text", values: ["never"], match: "any" },
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({ code: "browser_wait_timeout", retryable: true })
  })

  test("matches locator visibility and detachment", async () => {
    const transport = new FakeTransport()
    const controller = controllerFor(transport)

    expect(
      await controller.execute({
        type: "wait",
        condition: { type: "locator", locator: { kind: "css", value: "button" }, state: "visible" },
        timeoutMs: 2_000,
      }),
    ).toMatchObject({ type: "wait", matched: true })

    transport.locatorCount = 0
    expect(
      await controller.execute({
        type: "wait",
        condition: { type: "locator", locator: { kind: "css", value: "button" }, state: "detached" },
        timeoutMs: 2_000,
      }),
    ).toMatchObject({ type: "wait", matched: true })

    transport.locatorCount = 1
    transport.setCallFunction(() => ({
      visible: false,
      enabled: true,
      editable: true,
      receivesEvents: true,
      box: null,
    }))
    expect(
      await controller.execute({
        type: "wait",
        condition: { type: "locator", locator: { kind: "css", value: "button" }, state: "hidden" },
        timeoutMs: 2_000,
      }),
    ).toMatchObject({ type: "wait", matched: true })
  })

  test("matches download and dialog conditions", async () => {
    const transport = new FakeTransport()
    const controller = controllerFor(transport)
    transport.emit("Browser.downloadWillBegin", {
      guid: "download-1",
      url: "https://example.com/f.txt",
      suggestedFilename: "f.txt",
    })
    transport.emit("Page.javascriptDialogOpening", { type: "alert", message: "hi" })

    expect(await controller.execute({ type: "wait", condition: { type: "download" }, timeoutMs: 1_000 })).toMatchObject(
      { type: "wait", matched: true },
    )
    expect(await controller.execute({ type: "wait", condition: { type: "dialog" }, timeoutMs: 1_000 })).toMatchObject({
      type: "wait",
      matched: true,
    })
  })
})

describe("CdpPageController input actions", () => {
  test("dispatches key presses with named, printable, and unknown keys", async () => {
    const transport = new FakeTransport()
    const controller = controllerFor(transport, { platform: "darwin" })

    await controller.execute({
      type: "action",
      action: { type: "press", key: "Enter", modifiers: ["Shift", "Alt"], settleMode: "none" },
    })
    expect(
      transport.calls.some(
        (call) =>
          call.method === "Input.dispatchKeyEvent" &&
          call.params?.type === "keyDown" &&
          call.params?.key === "Enter" &&
          call.params?.modifiers === 9,
      ),
    ).toBe(true)

    await controller.execute({ type: "action", action: { type: "press", key: "a", settleMode: "none" } })
    expect(
      transport.calls.some(
        (call) =>
          call.method === "Input.dispatchKeyEvent" && call.params?.type === "keyDown" && call.params?.text === "a",
      ),
    ).toBe(true)

    await controller.execute({ type: "action", action: { type: "press", key: "Space", settleMode: "none" } })
    expect(
      transport.calls.some(
        (call) =>
          call.method === "Input.dispatchKeyEvent" && call.params?.type === "keyDown" && call.params?.text === " ",
      ),
    ).toBe(true)

    await controller.execute({ type: "action", action: { type: "press", key: "F13", settleMode: "none" } })
    expect(
      transport.calls.some(
        (call) =>
          call.method === "Input.dispatchKeyEvent" && call.params?.type === "keyDown" && call.params?.key === "F13",
      ),
    ).toBe(true)
  })

  test("maps ControlOrMeta to the platform modifier", async () => {
    const mac = new FakeTransport()
    await controllerFor(mac, { platform: "darwin" }).execute({
      type: "action",
      action: { type: "press", key: "Enter", modifiers: ["ControlOrMeta"], settleMode: "none" },
    })
    expect(mac.calls.some((call) => call.params?.type === "keyDown" && call.params?.modifiers === 4)).toBe(true)

    const windows = new FakeTransport()
    await controllerFor(windows, { platform: "win32" }).execute({
      type: "action",
      action: { type: "press", key: "Enter", modifiers: ["ControlOrMeta"], settleMode: "none" },
    })
    expect(windows.calls.some((call) => call.params?.type === "keyDown" && call.params?.modifiers === 2)).toBe(true)
  })

  test("dispatches double clicks, wheel scrolls, and drags on points", async () => {
    const transport = new FakeTransport()
    const controller = controllerFor(transport)

    await controller.execute({
      type: "action",
      action: { type: "dblclick", target: { kind: "point", x: 10, y: 20 }, settleMode: "none" },
    })
    expect(
      transport.calls.some(
        (call) =>
          call.method === "Input.dispatchMouseEvent" &&
          call.params?.type === "mousePressed" &&
          call.params?.clickCount === 2,
      ),
    ).toBe(true)

    await controller.execute({
      type: "action",
      action: { type: "scroll", target: { kind: "point", x: 5, y: 5 }, deltaX: 0, deltaY: 200, settleMode: "none" },
    })
    expect(
      transport.calls.some(
        (call) =>
          call.method === "Input.dispatchMouseEvent" &&
          call.params?.type === "mouseWheel" &&
          call.params?.deltaY === 200,
      ),
    ).toBe(true)

    await controller.execute({
      type: "action",
      action: {
        type: "drag",
        from: { kind: "point", x: 0, y: 0 },
        to: { kind: "point", x: 100, y: 100 },
        modifiers: ["Control"],
        settleMode: "none",
      },
    })
    const dragEvents = transport.calls.filter(
      (call) => call.method === "Input.dispatchMouseEvent" && call.params?.modifiers === 2,
    )
    expect(dragEvents.length).toBeGreaterThanOrEqual(12)
  })

  test("reports obstruction, disabled, and invisible targets", async () => {
    const obstruction = new FakeTransport()
    obstruction.setCallFunction(() => ({
      visible: true,
      enabled: true,
      editable: true,
      receivesEvents: false,
      box: { x: 10, y: 20, width: 100, height: 30 },
      obstruction: { tag: "div", role: "dialog", name: "Overlay" },
    }))
    await expect(
      controllerFor(obstruction).execute({
        type: "action",
        action: { type: "click", target: { kind: "css", value: "button" }, timeoutMs: 100, settleMode: "none" },
      }),
    ).rejects.toMatchObject({ code: "browser_obstructed" })

    const disabled = new FakeTransport()
    disabled.setCallFunction(() => ({
      visible: true,
      enabled: false,
      editable: true,
      receivesEvents: true,
      box: { x: 10, y: 20, width: 100, height: 30 },
    }))
    await expect(
      controllerFor(disabled).execute({
        type: "action",
        action: { type: "click", target: { kind: "css", value: "button" }, timeoutMs: 100, settleMode: "none" },
      }),
    ).rejects.toMatchObject({ code: "browser_target_disabled" })

    const invisible = new FakeTransport()
    invisible.setCallFunction(() => ({
      visible: false,
      enabled: true,
      editable: true,
      receivesEvents: true,
      box: null,
    }))
    await expect(
      controllerFor(invisible).execute({
        type: "action",
        action: { type: "click", target: { kind: "css", value: "button" }, timeoutMs: 100, settleMode: "none" },
      }),
    ).rejects.toMatchObject({ code: "browser_target_not_actionable" })
  })

  test("reports missing locators with a structured error", async () => {
    const transport = new FakeTransport()
    transport.locatorCount = 0
    const controller = controllerFor(transport)

    await expect(
      controller.execute({
        type: "action",
        action: { type: "click", target: { kind: "css", value: "button" }, settleMode: "none" },
      }),
    ).rejects.toMatchObject({ code: "browser_locator_not_found", retryable: true })
  })
})

describe("CdpPageController cleanup", () => {
  test("collects listener disposal failures into an AggregateError", async () => {
    const transport = new FakeTransport()
    const originalOn = transport.on.bind(transport)
    transport.on = (event, listener) => {
      const off = originalOn(event, listener)
      return () => {
        off()
        throw new Error("dispose failed")
      }
    }
    const controller = controllerFor(transport)

    await expect(controller.dispose()).rejects.toThrow("Browser CDP controller did not dispose cleanly")
  })

  test("drops a disposed listener set cleanly", async () => {
    const transport = new FakeTransport()
    const controller = controllerFor(transport)
    await expect(controller.dispose()).resolves.toBeUndefined()
  })
})

describe("BrowserProtocolError", () => {
  test("from preserves existing errors and wraps unknown failures", () => {
    const existing = new BrowserProtocolError({ code: "browser_test", message: "original", retryable: false })
    expect(BrowserProtocolError.from(existing, { code: "browser_test", message: "fallback", retryable: true })).toBe(
      existing,
    )

    const cause = new Error("boom")
    const wrapped = BrowserProtocolError.from(cause, { code: "browser_test", message: "fallback", retryable: true })
    expect(wrapped.message).toBe("boom")
    expect(wrapped.code).toBe("browser_test")
    expect(wrapped.cause).toBe(cause)

    const nonError = BrowserProtocolError.from("plain", { code: "browser_test", message: "fallback", retryable: true })
    expect(nonError.message).toBe("fallback")
    expect(nonError.cause).toBe("plain")
  })
})
