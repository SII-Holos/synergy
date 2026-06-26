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

    BrowserWebRTCSignaling.handleViewerMessage(owner, "tab_1", viewer.peer, {
      type: "webrtc.offer",
      tabId: "tab_1",
      sdp: "offer",
    })

    expect(viewer.messages).toEqual([
      {
        type: "webrtc.host.pending",
        tabId: "tab_1",
        code: "browser_webrtc_host_not_attached",
        message: "Waiting for Browser Host media transport.",
      },
    ])
  })

  test("forwards viewer and host signaling messages through the tab channel", () => {
    const viewer = socket()
    const host = socket()

    BrowserWebRTCSignaling.attachHost(owner, "tab_1", host.peer)
    BrowserWebRTCSignaling.attachViewer(owner, "tab_1", viewer.peer)
    BrowserWebRTCSignaling.handleViewerMessage(owner, "tab_1", viewer.peer, {
      type: "webrtc.offer",
      tabId: "tab_1",
      sdp: "offer",
    })
    BrowserWebRTCSignaling.handleHostMessage(owner, "tab_1", {
      type: "webrtc.answer",
      tabId: "tab_1",
      sdp: "answer",
    })

    expect(viewer.messages).toContainEqual({ type: "webrtc.host.ready", tabId: "tab_1" })
    expect(host.messages).toContainEqual({ type: "webrtc.offer", tabId: "tab_1", sdp: "offer" })
    expect(viewer.messages).toContainEqual({ type: "webrtc.answer", tabId: "tab_1", sdp: "answer" })
  })

  test("notifies the viewer when the Browser Host disconnects", () => {
    const viewer = socket()
    const host = socket()

    BrowserWebRTCSignaling.attachViewer(owner, "tab_1", viewer.peer)
    BrowserWebRTCSignaling.attachHost(owner, "tab_1", host.peer)
    BrowserWebRTCSignaling.detachHost(owner, "tab_1", host.peer)

    expect(viewer.messages).toContainEqual({
      type: "webrtc.host.pending",
      tabId: "tab_1",
      code: "browser_webrtc_host_disconnected",
      message: "Browser Host media transport disconnected.",
    })
  })
})
