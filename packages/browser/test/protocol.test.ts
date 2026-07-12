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
      }).success,
    ).toBe(true)
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
