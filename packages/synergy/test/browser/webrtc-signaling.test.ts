import { afterEach, describe, expect, test } from "bun:test"
import { BrowserWebRTCSignaling, type BrowserWebRTCSocket } from "../../src/browser/webrtc-signaling"
import type { BrowserOwner } from "../../src/browser/owner"

const owner: BrowserOwner.Info = {
  directory: "/tmp/synergy",
  scopeID: "scope",
  sessionID: "ses_webrtc",
  mode: "session",
}

function socket() {
  const messages: Record<string, unknown>[] = []
  const peer: BrowserWebRTCSocket = {
    send(data: string) {
      messages.push(JSON.parse(data))
    },
    close() {},
  }
  return { peer, messages }
}

describe("BrowserWebRTCSignaling", () => {
  afterEach(() => {
    BrowserWebRTCSignaling.resetForTest()
  })

  test("reports pending when a viewer offers before the Browser Host attaches", () => {
    const viewer = socket()

    BrowserWebRTCSignaling.handleViewerMessage(owner, "page_1", viewer.peer, {
      type: "webrtc.offer",
      pageId: "page_1",
      sdp: "offer",
    })

    expect(viewer.messages).toEqual([
      {
        type: "webrtc.host.pending",
        pageId: "page_1",
        code: "browser_webrtc_host_not_attached",
        message: "Waiting for Browser Host media transport.",
      },
    ])
  })

  test("forwards viewer and host signaling messages through the page channel", () => {
    const viewer = socket()
    const host = socket()

    BrowserWebRTCSignaling.attachHost(owner, "page_1", host.peer, { hostReady: true })
    BrowserWebRTCSignaling.attachViewer(owner, "page_1", viewer.peer, { hostReady: true })
    BrowserWebRTCSignaling.handleViewerMessage(owner, "page_1", viewer.peer, {
      type: "webrtc.offer",
      pageId: "page_1",
      sdp: "offer",
    })
    BrowserWebRTCSignaling.handleHostMessage(owner, "page_1", {
      type: "webrtc.answer",
      pageId: "page_1",
      sdp: "answer",
    })

    expect(viewer.messages).toContainEqual({ type: "webrtc.host.ready", pageId: "page_1" })
    expect(host.messages).toContainEqual({ type: "webrtc.offer", pageId: "page_1", sdp: "offer" })
    expect(viewer.messages).toContainEqual({ type: "webrtc.answer", pageId: "page_1", sdp: "answer" })
  })

  test("notifies the viewer when the Browser Host disconnects", () => {
    const viewer = socket()
    const host = socket()

    BrowserWebRTCSignaling.attachViewer(owner, "page_1", viewer.peer, { hostReady: false })
    BrowserWebRTCSignaling.attachHost(owner, "page_1", host.peer, { hostReady: true })
    BrowserWebRTCSignaling.detachHost(owner, "page_1", host.peer)

    expect(viewer.messages).toContainEqual({
      type: "webrtc.host.pending",
      pageId: "page_1",
      code: "browser_webrtc_host_disconnected",
      message: "Browser Host media transport disconnected.",
    })
  })

  test("ignores signaling messages from a stale viewer socket", () => {
    const oldViewer = socket()
    const newViewer = socket()
    const host = socket()

    BrowserWebRTCSignaling.attachHost(owner, "page_1", host.peer, { hostReady: true })
    BrowserWebRTCSignaling.attachViewer(owner, "page_1", oldViewer.peer, { hostReady: true })
    BrowserWebRTCSignaling.attachViewer(owner, "page_1", newViewer.peer, { hostReady: true })
    BrowserWebRTCSignaling.handleViewerMessage(owner, "page_1", oldViewer.peer, {
      type: "webrtc.close",
      pageId: "page_1",
    })

    expect(host.messages).not.toContainEqual({ type: "webrtc.close", pageId: "page_1" })

    BrowserWebRTCSignaling.handleViewerMessage(owner, "page_1", oldViewer.peer, {
      type: "webrtc.ice",
      pageId: "page_1",
      candidate: { candidate: "stale" },
    })

    expect(host.messages).not.toContainEqual({
      type: "webrtc.ice",
      pageId: "page_1",
      candidate: { candidate: "stale" },
    })

    BrowserWebRTCSignaling.handleViewerMessage(owner, "page_1", newViewer.peer, {
      type: "webrtc.offer",
      pageId: "page_1",
      sdp: "offer",
    })

    expect(host.messages).toContainEqual({ type: "webrtc.offer", pageId: "page_1", sdp: "offer" })
  })

  test("waits for explicit Host control readiness before notifying the viewer", () => {
    const viewer = socket()
    const host = socket()

    BrowserWebRTCSignaling.attachHost(owner, "page_1", host.peer, { hostReady: false })
    BrowserWebRTCSignaling.attachViewer(owner, "page_1", viewer.peer, { hostReady: false })

    expect(viewer.messages).not.toContainEqual({ type: "webrtc.host.ready", pageId: "page_1" })

    BrowserWebRTCSignaling.notifyHostReady(owner, "page_1", "trace_1")

    expect(viewer.messages).toContainEqual({ type: "webrtc.host.ready", pageId: "page_1", traceId: "trace_1" })
  })
})
