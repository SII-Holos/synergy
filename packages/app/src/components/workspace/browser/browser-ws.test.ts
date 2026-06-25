import { describe, expect, test } from "bun:test"
import { createBrowserWebSocketUrl, createQueuedBrowserSender } from "./browser-ws"

describe("createBrowserWebSocketUrl", () => {
  test("uses the route directory and scope id for home scope", () => {
    const url = createBrowserWebSocketUrl({
      serverUrl: "http://localhost:4096",
      sessionID: "ses_1",
      routeDirectory: "aG9tZQ",
      scopeID: "home",
      scopeKey: "home",
    })

    expect(url).not.toBeNull()
    const parsed = new URL(url!)
    expect(parsed.protocol).toBe("ws:")
    expect(parsed.pathname).toBe("/aG9tZQ/browser/connect")
    expect(parsed.searchParams.get("mode")).toBe("session")
    expect(parsed.searchParams.get("sessionID")).toBe("ses_1")
    expect(parsed.searchParams.get("presentation")).toBe("auto")
    expect(parsed.searchParams.get("client")).toBe("web")
    expect(parsed.searchParams.get("scopeID")).toBe("home")
    expect(parsed.searchParams.has("directory")).toBe(false)
  })

  test("uses the route directory and directory query for project scope", () => {
    const url = createBrowserWebSocketUrl({
      serverUrl: "https://synergy.local",
      sessionID: "ses_2",
      routeDirectory: "project-route",
      directory: "/Users/eric/project",
      scopeKey: "/Users/eric/project",
    })

    expect(url).not.toBeNull()
    const parsed = new URL(url!)
    expect(parsed.protocol).toBe("wss:")
    expect(parsed.pathname).toBe("/project-route/browser/connect")
    expect(parsed.searchParams.get("mode")).toBe("session")
    expect(parsed.searchParams.get("sessionID")).toBe("ses_2")
    expect(parsed.searchParams.get("presentation")).toBe("auto")
    expect(parsed.searchParams.get("client")).toBe("web")
    expect(parsed.searchParams.get("directory")).toBe("/Users/eric/project")
    expect(parsed.searchParams.has("scopeID")).toBe(false)
  })

  test("can request native presentation for a desktop client", () => {
    const url = createBrowserWebSocketUrl({
      serverUrl: "http://localhost:4096",
      sessionID: "ses_3",
      routeDirectory: "aG9tZQ",
      scopeID: "home",
      presentation: "native",
      client: "desktop",
    })

    expect(url).not.toBeNull()
    const parsed = new URL(url!)
    expect(parsed.searchParams.get("presentation")).toBe("native")
    expect(parsed.searchParams.get("client")).toBe("desktop")
  })

  test("returns null when no route or scope is available", () => {
    expect(createBrowserWebSocketUrl({ serverUrl: "http://localhost:4096", sessionID: "ses_1" })).toBeNull()
  })
})

describe("createQueuedBrowserSender", () => {
  test("queues messages until the socket opens", () => {
    const sent: string[] = []
    const socket = {
      readyState: 0,
      send: (data: string) => sent.push(data),
    }
    const sender = createQueuedBrowserSender(() => socket, { openState: 1 })

    sender.send({ type: "createTab", url: "www.google.com" })

    expect(sent).toEqual([])
    expect(sender.size()).toBe(1)

    socket.readyState = 1
    sender.flush()

    expect(sent.map((item) => JSON.parse(item))).toEqual([{ type: "createTab", url: "www.google.com" }])
    expect(sender.size()).toBe(0)
  })

  test("keeps the newest messages when the queue is full", () => {
    const sent: string[] = []
    const socket = {
      readyState: 0,
      send: (data: string) => sent.push(data),
    }
    const sender = createQueuedBrowserSender(() => socket, { openState: 1, maxPending: 2 })

    sender.send({ type: "first" })
    sender.send({ type: "second" })
    sender.send({ type: "third" })

    socket.readyState = 1
    sender.flush()

    expect(sent.map((item) => JSON.parse(item))).toEqual([{ type: "second" }, { type: "third" }])
  })
})
