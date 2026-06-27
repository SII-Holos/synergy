import { describe, expect, test } from "bun:test"
import { createBrowserWebRTCSignalingUrl } from "./browser-webrtc"
import {
  browserControlCommandFromMessage,
  createBrowserControlUrl,
  createBrowserEventsWebSocketUrl,
} from "./browser-ws"

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
    expect(parsed.searchParams.get("client")).toBe("web")
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
    expect(parsed.searchParams.get("client")).toBe("web")
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
      client: "desktop",
      sameHost: true,
    })

    expect(url).not.toBeNull()
    const parsed = new URL(url!)
    expect(parsed.searchParams.get("presentation")).toBe("native")
    expect(parsed.searchParams.get("client")).toBe("desktop")
    expect(parsed.searchParams.get("sameHost")).toBe("1")
  })

  test("builds the events URL without using the frame stream route", () => {
    const url = createBrowserEventsWebSocketUrl({
      serverUrl: "http://localhost:4096",
      sessionID: "ses_events",
      routeDirectory: "aG9tZQ",
      scopeID: "home",
      client: "desktop",
      sameHost: true,
    })

    expect(url).not.toBeNull()
    const parsed = new URL(url!)
    expect(parsed.protocol).toBe("ws:")
    expect(parsed.pathname).toBe("/aG9tZQ/browser/events")
    expect(parsed.searchParams.get("client")).toBe("desktop")
    expect(parsed.searchParams.get("sameHost")).toBe("1")
  })

  test("builds the control URL as an HTTP endpoint", () => {
    const url = createBrowserControlUrl({
      serverUrl: "https://synergy.local",
      sessionID: "ses_control",
      routeDirectory: "project-route",
      directory: "/Users/eric/project",
      client: "desktop",
      sameHost: true,
    })

    expect(url).not.toBeNull()
    const parsed = new URL(url!)
    expect(parsed.protocol).toBe("https:")
    expect(parsed.pathname).toBe("/project-route/browser/control")
    expect(parsed.searchParams.get("directory")).toBe("/Users/eric/project")
    expect(parsed.searchParams.get("client")).toBe("desktop")
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

  test("can bind WebRTC signaling to a specific tab", () => {
    const url = createBrowserWebRTCSignalingUrl({
      serverUrl: "https://synergy.local",
      sessionID: "ses_4",
      tabId: "tab_123",
      routeDirectory: "project-route",
      directory: "/Users/eric/project",
    })

    expect(url).not.toBeNull()
    const parsed = new URL(url!)
    expect(parsed.searchParams.get("tabId")).toBe("tab_123")
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
      tabId: "tab_1",
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
    expect(browserControlCommandFromMessage({ type: "createTab", url: "https://example.com" })).toEqual({
      type: "createTab",
      url: "https://example.com",
    })
    expect(browserControlCommandFromMessage({ type: "navigate", tabId: "tab_1", url: "www.google.com" })).toEqual({
      type: "navigate",
      source: "user",
      tabId: "tab_1",
      url: "www.google.com",
    })
  })
})
