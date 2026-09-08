import { describe, expect, test } from "bun:test"
import { BrowserUserCommandSchema } from "@ericsanchezok/synergy-browser"
import { createBrowserWebRTCSignalingUrl } from "../../../../src/components/workspace/browser/browser-webrtc"
import {
  browserControlCommandFromMessage,
  shouldResumeBrowserSession,
} from "../../../../src/components/workspace/browser/browser-command"
import { createBrowserEventsWebSocketUrl } from "../../../../src/components/workspace/browser/browser-ws"

describe("createBrowserWebSocketUrl", () => {
  test("uses the route directory and scope id for home scope", () => {
    const url = createBrowserEventsWebSocketUrl({
      serverUrl: "http://localhost:4096",
      sessionID: "ses_1",
      routeDirectory: "aG9tZQ",
      scopeID: "home",
      scopeKey: "home",
    })

    expect(url).not.toBeNull()
    const parsed = new URL(url!)
    expect(parsed.protocol).toBe("ws:")
    expect(parsed.pathname).toBe("/aG9tZQ/browser/events")
    expect(parsed.searchParams.get("mode")).toBe("session")
    expect(parsed.searchParams.get("sessionID")).toBe("ses_1")
    expect(parsed.searchParams.get("presentation")).toBe("auto")
    expect(parsed.searchParams.has("client")).toBe(false)
    expect(parsed.searchParams.get("scopeID")).toBe("home")
    expect(parsed.searchParams.has("directory")).toBe(false)
  })

  test("uses the route directory and directory query for project scope", () => {
    const url = createBrowserEventsWebSocketUrl({
      serverUrl: "https://synergy.local",
      sessionID: "ses_2",
      routeDirectory: "project-route",
      directory: "/Users/eric/project",
      scopeKey: "/Users/eric/project",
    })

    expect(url).not.toBeNull()
    const parsed = new URL(url!)
    expect(parsed.protocol).toBe("wss:")
    expect(parsed.pathname).toBe("/project-route/browser/events")
    expect(parsed.searchParams.get("mode")).toBe("session")
    expect(parsed.searchParams.get("sessionID")).toBe("ses_2")
    expect(parsed.searchParams.get("presentation")).toBe("auto")
    expect(parsed.searchParams.has("client")).toBe(false)
    expect(parsed.searchParams.get("directory")).toBe("/Users/eric/project")
    expect(parsed.searchParams.has("scopeID")).toBe(false)
  })

  test("can request native presentation for a desktop client", () => {
    const url = createBrowserEventsWebSocketUrl({
      serverUrl: "http://localhost:4096",
      sessionID: "ses_3",
      routeDirectory: "aG9tZQ",
      scopeID: "home",
      presentation: "native",
    })

    expect(url).not.toBeNull()
    const parsed = new URL(url!)
    expect(parsed.searchParams.get("presentation")).toBe("native")
    expect(parsed.searchParams.has("client")).toBe(false)
  })

  test("builds the events URL without using the frame stream route", () => {
    const url = createBrowserEventsWebSocketUrl({
      serverUrl: "http://localhost:4096",
      sessionID: "ses_events",
      routeDirectory: "aG9tZQ",
      scopeID: "home",
    })

    expect(url).not.toBeNull()
    const parsed = new URL(url!)
    expect(parsed.protocol).toBe("ws:")
    expect(parsed.pathname).toBe("/aG9tZQ/browser/events")
    expect(parsed.searchParams.has("client")).toBe(false)
  })

  test("builds the WebRTC signaling URL without using the frame stream route", () => {
    const url = createBrowserWebRTCSignalingUrl({
      serverUrl: "https://synergy.local",
      sessionID: "ses_4",
      routeDirectory: "project-route",
      directory: "/Users/eric/project",
    })

    expect(url).not.toBeNull()
    const parsed = new URL(url!)
    expect(parsed.protocol).toBe("wss:")
    expect(parsed.pathname).toBe("/project-route/browser/webrtc/connect")
    expect(parsed.searchParams.get("presentation")).toBe("webrtc")
    expect(parsed.searchParams.get("directory")).toBe("/Users/eric/project")
  })

  test("can bind WebRTC signaling to a specific page", () => {
    const url = createBrowserWebRTCSignalingUrl({
      serverUrl: "https://synergy.local",
      sessionID: "ses_4",
      pageId: "page_123",
      routeDirectory: "project-route",
      directory: "/Users/eric/project",
    })

    expect(url).not.toBeNull()
    const parsed = new URL(url!)
    expect(parsed.searchParams.get("pageId")).toBe("page_123")
  })

  test("adds trace ids to browser route URLs", () => {
    const eventsUrl = createBrowserEventsWebSocketUrl({
      serverUrl: "http://localhost:4096",
      sessionID: "ses_trace",
      routeDirectory: "aG9tZQ",
      scopeID: "home",
      traceId: "browser_trace_1",
    })
    const webrtcUrl = createBrowserWebRTCSignalingUrl({
      serverUrl: "http://localhost:4096",
      sessionID: "ses_trace",
      pageId: "page_1",
      routeDirectory: "aG9tZQ",
      scopeID: "home",
      traceId: "browser_trace_1",
    })

    expect(new URL(eventsUrl!).searchParams.get("traceId")).toBe("browser_trace_1")
    expect(new URL(webrtcUrl!).searchParams.get("traceId")).toBe("browser_trace_1")
  })

  test("returns null when no route or scope is available", () => {
    expect(createBrowserEventsWebSocketUrl({ serverUrl: "http://localhost:4096", sessionID: "ses_1" })).toBeNull()
  })
})

describe("browserControlCommandFromMessage", () => {
  test("maps browser chrome commands to host control commands", () => {
    expect(browserControlCommandFromMessage({ type: "navigate", pageId: "page_1", url: "www.google.com" })).toEqual({
      type: "navigate",
      source: "user",
      url: "www.google.com",
    })
    const fileChooser = browserControlCommandFromMessage({
      type: "filechooser.select",
      requestId: "chooser-1",
      files: [{ name: "fixture.txt", mimeType: "text/plain", dataBase64: "Zml4dHVyZQ==" }],
    })
    expect(BrowserUserCommandSchema.safeParse(fileChooser).success).toBe(true)
  })

  test("keeps remote input off the HTTP control route", () => {
    expect(browserControlCommandFromMessage({ type: "input.text", pageId: "page_1", text: "中文搜索" })).toBeNull()
    expect(browserControlCommandFromMessage({ type: "input.key", pageId: "page_1", action: "down" })).toBeNull()
    expect(browserControlCommandFromMessage({ type: "input.mouse", pageId: "page_1", action: "wheel" })).toBeNull()
  })
})

describe("Browser session bootstrap", () => {
  const state = {
    type: "session.state" as const,
    protocolVersion: 2 as const,
    ownerKey: "owner-1",
    status: "active" as const,
    page: { id: "page-1", url: "https://example.com", title: "", isLoading: false, lastActiveAt: null },
    presentation: null,
    hostStatus: "detached" as const,
    seq: 0,
    epoch: "epoch-1",
  }

  test("resumes only active pages that are not attached to a Host", () => {
    expect(shouldResumeBrowserSession(state)).toBe(true)
    expect(shouldResumeBrowserSession({ ...state, hostStatus: "ready" })).toBe(false)
    expect(shouldResumeBrowserSession({ ...state, status: "suspended" })).toBe(false)
    expect(shouldResumeBrowserSession({ ...state, status: "empty", page: null })).toBe(false)
  })
})
