import { describe, expect, test } from "bun:test"
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserActionSchema,
  BrowserBackendCommandSchema,
  BrowserCheckpointSchema,
  BrowserEventSchema,
  BrowserDownloadEntrySchema,
  BrowserHostMessageSchema,
  BrowserHostDownloadEntrySchema,
  BrowserLocatorSchema,
  BrowserNativeAttachRequestSchema,
  BrowserNativeViewEventSchema,
  BrowserRemoteInputSchema,
  BrowserRegistrationSecretSchema,
  BrowserSessionStateSchema,
  BrowserUserCommandSchema,
  BrowserWaitConditionSchema,
  BrowserWebRTCSignalSchema,
  BrowserWebRTCMessageSchema,
  browserOwnerKey,
  normalizeBrowserURL,
  parseBrowserPresentationPreference,
  selectBrowserPresentation,
} from "../src/protocol"

describe("browser protocol v2", () => {
  test("accepts workspace file checkpoints without granting path access", () => {
    expect(
      BrowserCheckpointSchema.parse({
        url: "file:///workspace/index.html",
        cookies: [],
        origins: [],
        viewport: { width: 1280, height: 720 },
        scroll: { x: 0, y: 0 },
        formState: [],
      }).url,
    ).toBe("file:///workspace/index.html")
  })
  test("uses a versioned strict protocol", () => {
    expect(BROWSER_PROTOCOL_VERSION).toBe(2)
    expect(
      BrowserSessionStateSchema.parse({
        type: "session.state",
        protocolVersion: 2,
        ownerKey: "owner-1",
        status: "empty",
        page: null,
        presentation: null,
        hostStatus: "unavailable",
        seq: 0,
        epoch: "epoch-1",
      }).status,
    ).toBe("empty")
    expect(() =>
      BrowserSessionStateSchema.parse({
        type: "session.state",
        protocolVersion: 2,
        ownerKey: "owner-1",
        status: "empty",
        page: null,
        presentation: null,
        hostStatus: "unavailable",
        seq: 0,
        epoch: "epoch-1",
        legacy: true,
      }),
    ).toThrow()
    expect(BrowserRegistrationSecretSchema.safeParse("weak-secret").success).toBe(false)
    expect(BrowserRegistrationSecretSchema.safeParse("a".repeat(64)).success).toBe(true)
  })

  test("does not fall back when a presentation is explicitly requested", () => {
    expect(
      selectBrowserPresentation({
        desktopLocalHost: false,
        remote: true,
        requested: "native",
        capabilities: { native: true, webrtc: true },
      }),
    ).toBeNull()
    // An explicit WebRTC request still requires the WebRTC capability: the
    // route relies on a null selection to surface the retryable
    // "host unavailable" error instead of a non-retryable command failure.
    expect(
      selectBrowserPresentation({
        desktopLocalHost: true,
        remote: false,
        requested: "webrtc",
        capabilities: { native: true, webrtc: false },
      }),
    ).toBeNull()
    expect(
      selectBrowserPresentation({
        desktopLocalHost: true,
        remote: false,
        requested: "webrtc",
        capabilities: { native: true, webrtc: true },
      })?.kind,
    ).toBe("webrtc")
  })

  test("accepts a page-scoped Host signaling ticket renewal message", () => {
    const renewal = {
      type: "page.signaling.ticket",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: "owner-1",
      pageId: "page-1",
      signalingTicket: "fresh-host-ticket",
    }

    expect(BrowserHostMessageSchema.safeParse(renewal).success).toBe(true)
    expect(BrowserHostMessageSchema.safeParse({ ...renewal, pageId: undefined }).success).toBe(false)
    expect(BrowserHostMessageSchema.safeParse({ ...renewal, unexpected: true }).success).toBe(false)
  })

  test("derives unambiguous owner keys from delimiter-shaped ids", () => {
    expect(browserOwnerKey({ mode: "session", scopeID: "a:b", sessionID: "c" })).not.toBe(
      browserOwnerKey({ mode: "session", scopeID: "a", sessionID: "b:c" }),
    )
  })

  test("accepts only structured locator objects", () => {
    expect(BrowserLocatorSchema.parse({ kind: "role", role: "button", name: "Continue with Holos" })).toEqual({
      kind: "role",
      role: "button",
      name: "Continue with Holos",
    })
    expect(BrowserLocatorSchema.parse({ kind: "css", value: "button.primary" })).toEqual({
      kind: "css",
      value: "button.primary",
    })
    expect(
      BrowserLocatorSchema.safeParse({
        kind: "ref",
        snapshotId: "snapshot",
        ref: "@1-1",
        within: { kind: "css", value: "main" },
      }).success,
    ).toBe(false)
  })

  test("bounds nested locator scopes", () => {
    const locator = (depth: number): Record<string, unknown> => ({
      kind: "css",
      value: "main",
      ...(depth > 0 ? { within: locator(depth - 1) } : {}),
    })

    expect(BrowserLocatorSchema.safeParse(locator(8)).success).toBe(true)
    expect(BrowserLocatorSchema.safeParse(locator(9)).success).toBe(false)

    const branch = (depth: number): Record<string, unknown> => ({
      kind: "css",
      value: "iframe",
      ...(depth > 0 ? { framePath: Array.from({ length: 8 }, () => branch(depth - 1)) } : {}),
    })
    expect(BrowserLocatorSchema.safeParse(branch(3)).success).toBe(false)

    const cyclic: Record<string, unknown> = { kind: "css", value: "main" }
    cyclic.within = cyclic
    expect(BrowserLocatorSchema.safeParse(cyclic).success).toBe(false)
    expect(
      BrowserLocatorSchema.safeParse({
        kind: "css",
        value: "button",
        within: {
          kind: "css",
          value: "main",
          framePath: [{ kind: "css", value: "iframe" }],
        },
      }).success,
    ).toBe(false)
  })

  test("uses action-specific fields instead of optional bags", () => {
    expect(BrowserActionSchema.parse({ type: "fill", target: { kind: "label", text: "Name" }, value: "Ada" })).toEqual({
      type: "fill",
      target: { kind: "label", text: "Name" },
      value: "Ada",
    })
    expect(() =>
      BrowserActionSchema.parse({ type: "fill", target: { kind: "label", text: "Name" }, text: "Ada" }),
    ).toThrow()
    expect(BrowserBackendCommandSchema.safeParse({ type: "console", action: "clear", page: 0 }).success).toBe(false)
    expect(
      BrowserBackendCommandSchema.safeParse({ type: "network", action: "get", id: "request-1", status: 200 }).success,
    ).toBe(false)
    expect(
      BrowserBackendCommandSchema.safeParse({
        type: "checkpoint",
        action: "restore",
      }).success,
    ).toBe(false)
    expect(
      BrowserBackendCommandSchema.safeParse({
        type: "screenshot",
        fullPage: true,
        clip: { x: 0, y: 0, width: 1, height: 1 },
      }).success,
    ).toBe(false)
    expect(BrowserBackendCommandSchema.safeParse({ type: "screenshot", fullPage: false }).success).toBe(false)
    expect(BrowserBackendCommandSchema.safeParse({ type: "emulate", emulation: {} }).success).toBe(false)
    expect(
      BrowserBackendCommandSchema.safeParse({ type: "dialog", action: "status", promptText: "unused" }).success,
    ).toBe(false)
    expect(BrowserBackendCommandSchema.safeParse({ type: "clipboard", action: "write" }).success).toBe(false)
    expect(BrowserBackendCommandSchema.safeParse({ type: "clipboard", action: "read", text: "unused" }).success).toBe(
      false,
    )
    expect(
      BrowserBackendCommandSchema.safeParse({ type: "performance", action: "measure", exportPath: "unused" }).success,
    ).toBe(false)
    expect(
      BrowserBackendCommandSchema.safeParse({
        type: "upload",
        target: { kind: "css", value: "input[type=file]" },
        files: [{ name: "file.txt", mimeType: "text/plain", dataBase64: "***" }],
      }).success,
    ).toBe(false)
    expect(
      BrowserBackendCommandSchema.safeParse({ type: "clipboard", action: "write", text: "😀".repeat(300_000) }).success,
    ).toBe(false)
    expect(
      BrowserBackendCommandSchema.parse({ type: "evaluate", mode: "readonly", expression: "document.title" }),
    ).toMatchObject({ timeoutMs: 10_000 })
  })

  test("supports deterministic wait conditions", () => {
    expect(
      BrowserWaitConditionSchema.parse({
        type: "locator",
        locator: { kind: "role", role: "button", name: "Plugins" },
        state: "visible",
      }),
    ).toEqual({
      type: "locator",
      locator: { kind: "role", role: "button", name: "Plugins" },
      state: "visible",
    })
    expect(BrowserWaitConditionSchema.parse({ type: "text", values: ["Ready"], match: "any" }).type).toBe("text")
  })

  test("keeps privileged backend commands out of the user route", () => {
    expect(
      BrowserBackendCommandSchema.safeParse({ type: "evaluate", mode: "trusted", expression: "document.title" })
        .success,
    ).toBe(true)
    expect(
      BrowserUserCommandSchema.safeParse({ type: "evaluate", mode: "trusted", expression: "document.title" }).success,
    ).toBe(false)
    expect(BrowserUserCommandSchema.safeParse({ type: "cdp", method: "Runtime.evaluate" }).success).toBe(false)
    expect(
      BrowserUserCommandSchema.safeParse({ type: "navigate", url: "https://example.com", unexpected: true }).success,
    ).toBe(false)
  })

  test("strictly validates event, host broker, and WebRTC discriminators", () => {
    expect(
      BrowserEventSchema.parse({
        type: "page.closed",
        protocolVersion: 2,
        seq: 1,
        epoch: "epoch-1",
        pageId: "page-1",
      }).type,
    ).toBe("page.closed")
    expect(
      BrowserHostMessageSchema.safeParse({
        type: "host.register",
        protocolVersion: 1,
        hostId: "host",
        token: "token",
        capabilities: { native: true, webrtc: true },
      }).success,
    ).toBe(false)
    expect(
      BrowserWebRTCSignalSchema.safeParse({
        type: "webrtc.ice",
        protocolVersion: 2,
        connectionId: "connection",
        generation: 1,
        sequence: -1,
        pageId: "page-1",
        candidate: {},
      }).success,
    ).toBe(false)
    expect(
      BrowserWebRTCMessageSchema.safeParse({
        type: "webrtc.host.ready",
        protocolVersion: 2,
        pageId: "page-1",
      }).success,
    ).toBe(true)
    expect(BrowserWebRTCMessageSchema.safeParse({ type: "webrtc.host.ready", pageId: "page-1" }).success).toBe(false)
    expect(
      BrowserEventSchema.safeParse({
        type: "page.closed",
        protocolVersion: 2,
        seq: 1,
        epoch: "epoch-1",
        pageId: "page-1",
        extra: true,
      }).success,
    ).toBe(false)
    expect(
      BrowserRemoteInputSchema.safeParse({
        type: "input.key",
        protocolVersion: 2,
        pageId: "page-1",
        action: "down",
        key: "Enter",
      }).success,
    ).toBe(true)
    expect(
      BrowserRemoteInputSchema.safeParse({
        type: "input.text",
        pageId: "page-1",
        text: "unversioned",
      }).success,
    ).toBe(false)
    expect(
      BrowserNativeAttachRequestSchema.safeParse({
        protocolVersion: 2,
        ownerKey: "scope:scope:session:session",
        pageId: "page-1",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: false,
      }).success,
    ).toBe(true)
    expect(
      BrowserNativeAttachRequestSchema.safeParse({
        protocolVersion: 2,
        ownerKey: "scope:scope:session:session",
        pageId: "page-1",
        visible: "hidden",
      }).success,
    ).toBe(false)
    expect(
      BrowserNativeAttachRequestSchema.safeParse({
        protocolVersion: 2,
        ownerKey: "scope:scope:session:session",
        pageId: "page-1",
        sessionID: "retired-field",
      }).success,
    ).toBe(false)
    expect(
      BrowserNativeViewEventSchema.safeParse({
        type: "native.loaded",
        protocolVersion: 2,
        pageId: "page-1",
        url: "https://example.com/",
        title: "Example",
      }).success,
    ).toBe(true)
  })

  test("rejects oversized selectors, eval expressions, and viewport payloads", () => {
    expect(BrowserLocatorSchema.safeParse({ kind: "css", value: "x".repeat(20_001) }).success).toBe(false)
    expect(
      BrowserBackendCommandSchema.safeParse({
        type: "evaluate",
        mode: "readonly",
        expression: "x".repeat(1_000_001),
      }).success,
    ).toBe(false)
    expect(BrowserUserCommandSchema.safeParse({ type: "setViewport", width: 20_000, height: 600 }).success).toBe(false)
  })

  test("uses a strict owner-isolated download event contract", () => {
    const entry = {
      id: "download-1",
      url: "https://example.com/file.txt",
      fileName: "file.txt",
      mimeType: "text/plain",
      state: "completed",
      totalBytes: 10,
      receivedBytes: 10,
      timestamp: 1,
    }
    expect(BrowserDownloadEntrySchema.safeParse(entry).success).toBe(true)
    expect(BrowserDownloadEntrySchema.safeParse({ ...entry, path: "/managed/file" }).success).toBe(false)
    expect(BrowserHostDownloadEntrySchema.safeParse({ ...entry, path: "/managed/file" }).success).toBe(true)
    expect(BrowserHostDownloadEntrySchema.safeParse({ ...entry, clientPath: "/tmp/file" }).success).toBe(false)
  })
})

describe("browser URL normalization and presentation preference", () => {
  test("normalizes localhost, domains, URLs, and search queries", () => {
    expect(normalizeBrowserURL("localhost")).toBe("http://localhost")
    expect(normalizeBrowserURL("localhost:3000/app")).toBe("http://localhost:3000/app")
    expect(normalizeBrowserURL("127.0.0.1:8080")).toBe("http://127.0.0.1:8080")
    expect(normalizeBrowserURL("example.com")).toBe("https://example.com")
    expect(normalizeBrowserURL("example.com:8443/path")).toBe("https://example.com:8443/path")
    expect(normalizeBrowserURL("https://example.com/a")).toBe("https://example.com/a")
    expect(normalizeBrowserURL("/docs", "https://example.com")).toBe("https://example.com/docs")
    expect(normalizeBrowserURL("synergy browser")).toBe("https://www.google.com/search?q=synergy%20browser")
    expect(() => normalizeBrowserURL("   ")).toThrow("URL is required")
    expect(normalizeBrowserURL("::::")).toBe("https://www.google.com/search?q=%3A%3A%3A%3A")
  })

  test("parses presentation preferences with a safe auto fallback", () => {
    expect(parseBrowserPresentationPreference("native")).toBe("native")
    expect(parseBrowserPresentationPreference("webrtc")).toBe("webrtc")
    expect(parseBrowserPresentationPreference("bogus")).toBe("auto")
    expect(parseBrowserPresentationPreference(null)).toBe("auto")
    expect(parseBrowserPresentationPreference(undefined)).toBe("auto")
  })

  test("auto-selection prefers local native and falls back to WebRTC or null", () => {
    expect(
      selectBrowserPresentation({
        desktopLocalHost: true,
        remote: false,
        capabilities: { native: true, webrtc: true },
      }),
    ).toMatchObject({ kind: "native", reason: "desktop-local" })
    expect(
      selectBrowserPresentation({
        desktopLocalHost: true,
        remote: false,
        capabilities: { native: true, webrtc: false },
      }),
    ).toMatchObject({ kind: "native", reason: "desktop-local" })
    expect(
      selectBrowserPresentation({
        desktopLocalHost: true,
        remote: true,
        capabilities: { native: true, webrtc: true },
      }),
    ).toMatchObject({ kind: "webrtc", reason: "remote-client" })
    expect(
      selectBrowserPresentation({
        desktopLocalHost: false,
        remote: true,
        capabilities: { native: false, webrtc: true },
      }),
    ).toMatchObject({ kind: "webrtc", reason: "remote-client" })
    expect(
      selectBrowserPresentation({
        desktopLocalHost: false,
        remote: true,
        capabilities: { native: true, webrtc: false },
      }),
    ).toBeNull()
    expect(
      selectBrowserPresentation({
        desktopLocalHost: false,
        remote: true,
        capabilities: { native: false, webrtc: false },
      }),
    ).toBeNull()
  })
})

describe("browser Host page lifecycle messages", () => {
  const baseCreate = {
    type: "page.create",
    protocolVersion: 2,
    requestId: "request-1",
    ownerKey: "scope:scope-1:session:session-1",
    owner: { mode: "session", scopeID: "scope-1", directory: "/workspace", sessionID: "session-1" },
    routeDirectory: "/route",
    presentation: "native",
    page: {
      id: "page-1",
      url: "https://example.com/",
      title: "Example",
      isLoading: false,
      lastActiveAt: 1,
    },
    networkProxy: { server: "http://proxy:8080", username: "user", password: "pass" },
    downloadDir: "/downloads",
  }

  test("enforces owner/ticket consistency on page.create", () => {
    expect(BrowserHostMessageSchema.safeParse(baseCreate).success).toBe(true)
    expect(
      BrowserHostMessageSchema.safeParse({
        ...baseCreate,
        owner: { ...baseCreate.owner, sessionID: undefined },
      }).success,
    ).toBe(false)
    expect(
      BrowserHostMessageSchema.safeParse({
        ...baseCreate,
        owner: { mode: "scope", scopeID: "scope-1", directory: "/workspace", sessionID: "session-1" },
      }).success,
    ).toBe(false)
    expect(BrowserHostMessageSchema.safeParse({ ...baseCreate, ownerKey: "mismatch" }).success).toBe(false)
    expect(
      BrowserHostMessageSchema.safeParse({ ...baseCreate, presentation: "webrtc", signalingTicket: undefined }).success,
    ).toBe(false)
    expect(
      BrowserHostMessageSchema.safeParse({ ...baseCreate, presentation: "native", signalingTicket: "ticket" }).success,
    ).toBe(false)
    expect(
      BrowserHostMessageSchema.safeParse({ ...baseCreate, presentation: "webrtc", signalingTicket: "ticket" }).success,
    ).toBe(true)
  })

  test("requires exactly one of result or error on page.result", () => {
    const baseResult = {
      type: "page.result",
      protocolVersion: 2,
      requestId: "request-1",
      result: { type: "void" },
    }
    expect(BrowserHostMessageSchema.safeParse(baseResult).success).toBe(true)
    expect(
      BrowserHostMessageSchema.safeParse({
        ...baseResult,
        result: undefined,
        error: { type: "error", code: "browser_test", message: "failed", retryable: false },
      }).success,
    ).toBe(true)
    expect(
      BrowserHostMessageSchema.safeParse({
        ...baseResult,
        error: { type: "error", code: "browser_test", message: "failed", retryable: false },
      }).success,
    ).toBe(false)
    expect(BrowserHostMessageSchema.safeParse({ ...baseResult, result: undefined }).success).toBe(false)
  })
})

describe("browser upload and checkpoint schema limits", () => {
  test("rejects invalid base64 and oversized upload content", () => {
    const upload = (dataBase64: string) => ({
      type: "upload",
      target: { kind: "css", value: "input[type=file]" },
      files: [{ name: "file.txt", mimeType: "text/plain", dataBase64 }],
    })
    expect(BrowserBackendCommandSchema.safeParse(upload("dGVzdA==")).success).toBe(true)
    expect(BrowserBackendCommandSchema.safeParse(upload("***not-base64***")).success).toBe(false)
    expect(BrowserBackendCommandSchema.safeParse(upload("a".repeat(35 * 1024 * 1024))).success).toBe(false)
    const manyFiles = upload("dGVzdA==")
    const files = Array.from({ length: 21 }, () => ({ name: "f.txt", mimeType: "text/plain", dataBase64: "dGVzdA==" }))
    expect(BrowserBackendCommandSchema.safeParse({ type: "upload", target: manyFiles.target, files }).success).toBe(
      false,
    )
  })

  test("rejects checkpoints over the 32 MB limit", () => {
    const checkpoint = BrowserCheckpointSchema.parse({
      url: "https://example.com/",
      cookies: [],
      origins: [],
      viewport: { width: 1280, height: 720 },
      scroll: { x: 0, y: 0 },
      formState: [],
    })
    const oversized = {
      ...checkpoint,
      origins: [
        {
          origin: "https://example.com",
          localStorage: { big: "x".repeat(32 * 1024 * 1024) },
          sessionStorage: {},
        },
      ],
    }
    expect(BrowserCheckpointSchema.safeParse(oversized).success).toBe(false)
  })

  test("rejects list-only and get-only fields on the wrong console/network actions", () => {
    expect(
      BrowserBackendCommandSchema.safeParse({ type: "console", action: "get", id: "console-1", level: "log" }).success,
    ).toBe(false)
    expect(
      BrowserBackendCommandSchema.safeParse({ type: "network", action: "get", id: "req-1", resourceTypes: ["XHR"] })
        .success,
    ).toBe(false)
    expect(BrowserBackendCommandSchema.safeParse({ type: "network", action: "clear", includeBody: true }).success).toBe(
      false,
    )
    expect(
      BrowserBackendCommandSchema.safeParse({ type: "network", action: "clear", includeSensitive: true }).success,
    ).toBe(false)
    expect(BrowserBackendCommandSchema.safeParse({ type: "network", action: "list", includeBody: true }).success).toBe(
      false,
    )
  })
})

test("falls back to a search URL when a base-relative URL cannot be constructed", () => {
  expect(normalizeBrowserURL("http://", "https://example.com")).toBe("https://www.google.com/search?q=http%3A%2F%2F")
  expect(browserOwnerKey({ mode: "scope", scopeID: "scope-1" })).toBe("scope:scope-1:scope")
})
