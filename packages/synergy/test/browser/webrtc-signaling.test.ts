import { afterEach, describe, expect, test } from "bun:test"
import { BrowserWebRTCSignaling } from "../../src/browser/webrtc-signaling"
import type { BrowserOwner } from "../../src/browser/owner"

const owner: BrowserOwner.Info = { mode: "session", scopeID: "scope", sessionID: "session", directory: "/tmp" }

function peer() {
  const messages: any[] = []
  let closed: number | undefined
  return {
    messages,
    get closed() {
      return closed
    },
    socket: {
      send(data: string) {
        messages.push(JSON.parse(data))
      },
      close(code?: number) {
        closed = code
      },
    },
  }
}

const offer = (connectionId: string, generation: number) => ({
  type: "webrtc.offer" as const,
  protocolVersion: 2 as const,
  pageId: "page-1",
  connectionId,
  generation,
  sdp: `offer-${connectionId}-${generation}`,
})

afterEach(() => BrowserWebRTCSignaling.resetForTest())

describe("BrowserWebRTCSignaling v2", () => {
  test("forwards only signals for the active connection and generation", () => {
    const viewer = peer()
    const host = peer()
    BrowserWebRTCSignaling.attachViewer(owner, "page-1", viewer.socket, { hostReady: true })
    BrowserWebRTCSignaling.attachHost(owner, "page-1", host.socket, { hostReady: true })
    BrowserWebRTCSignaling.handleViewerMessage(owner, "page-1", viewer.socket, offer("connection-a", 1))
    BrowserWebRTCSignaling.handleHostMessage(owner, "page-1", {
      type: "webrtc.answer",
      protocolVersion: 2,
      pageId: "page-1",
      connectionId: "connection-a",
      generation: 1,
      sdp: "answer",
    })
    BrowserWebRTCSignaling.handleHostMessage(owner, "page-1", {
      type: "webrtc.answer",
      protocolVersion: 2,
      pageId: "page-1",
      connectionId: "stale",
      generation: 0,
      sdp: "stale",
    })
    expect(host.messages).toContainEqual(offer("connection-a", 1))
    expect(viewer.messages.some((message) => message.sdp === "answer")).toBe(true)
    expect(viewer.messages.some((message) => message.sdp === "stale")).toBe(false)
  })

  test("rejects replayed and out-of-order ICE candidates", () => {
    const viewer = peer()
    const host = peer()
    BrowserWebRTCSignaling.attachViewer(owner, "page-1", viewer.socket, { hostReady: true })
    BrowserWebRTCSignaling.attachHost(owner, "page-1", host.socket, { hostReady: true })
    BrowserWebRTCSignaling.handleViewerMessage(owner, "page-1", viewer.socket, offer("connection-a", 2))
    const ice = (sequence: number) => ({
      type: "webrtc.ice" as const,
      protocolVersion: 2 as const,
      pageId: "page-1",
      connectionId: "connection-a",
      generation: 2,
      sequence,
      candidate: { candidate: String(sequence) },
    })
    BrowserWebRTCSignaling.handleViewerMessage(owner, "page-1", viewer.socket, ice(1))
    BrowserWebRTCSignaling.handleViewerMessage(owner, "page-1", viewer.socket, ice(1))
    BrowserWebRTCSignaling.handleViewerMessage(owner, "page-1", viewer.socket, ice(0))
    expect(host.messages.filter((message) => message.type === "webrtc.ice")).toEqual([ice(1)])
  })

  test("replaces an old viewer and prevents it from retaking signaling", () => {
    const oldViewer = peer()
    const newViewer = peer()
    const host = peer()
    BrowserWebRTCSignaling.attachViewer(owner, "page-1", oldViewer.socket, { hostReady: false })
    BrowserWebRTCSignaling.attachHost(owner, "page-1", host.socket, { hostReady: true })
    BrowserWebRTCSignaling.handleViewerMessage(owner, "page-1", oldViewer.socket, offer("old-active", 5))
    BrowserWebRTCSignaling.attachViewer(owner, "page-1", newViewer.socket, { hostReady: true })
    BrowserWebRTCSignaling.handleViewerMessage(owner, "page-1", oldViewer.socket, offer("old", 1))
    BrowserWebRTCSignaling.handleViewerMessage(owner, "page-1", newViewer.socket, offer("new", 1))
    expect(oldViewer.closed).toBe(4001)
    expect(host.messages.some((message) => message.connectionId === "old")).toBe(false)
    expect(host.messages.some((message) => message.connectionId === "new")).toBe(true)
    expect(host.messages).toContainEqual(
      expect.objectContaining({ type: "webrtc.close", connectionId: "old-active", generation: 5 }),
    )
  })

  test("enforces viewer and host signaling roles", () => {
    expect(BrowserWebRTCSignaling.acceptsRole("viewer", offer("viewer", 1))).toBe(true)
    expect(
      BrowserWebRTCSignaling.acceptsRole("viewer", {
        type: "webrtc.answer",
        protocolVersion: 2,
        pageId: "page-1",
        connectionId: "viewer",
        generation: 1,
        sdp: "answer",
      }),
    ).toBe(false)
    expect(BrowserWebRTCSignaling.acceptsRole("host", offer("host", 1))).toBe(false)
    expect(
      BrowserWebRTCSignaling.acceptsRole("host", {
        type: "webrtc.error",
        protocolVersion: 2,
        pageId: "page-1",
        connectionId: "host",
        generation: 1,
        message: "capture failed",
      }),
    ).toBe(true)
  })
})
